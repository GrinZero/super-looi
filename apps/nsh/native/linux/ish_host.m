// Super LOOI's iSH host adapter. GPL-3.0-or-later with upstream LICENSE.IOS.
// Recovery follows OpenMinis/ISHKernel.m at the revision in sources.lock.json.
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <TargetConditionals.h>
#include <mach/mach.h>
#include <os/proc.h>
#include <stdatomic.h>
#include <signal.h>
#include <sys/ucontext.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include "kernel/init.h"
#include "fs/fd.h"
#include "fs/path.h"
#include "kernel/task.h"
#include "kernel/calls.h"
#include "kernel/signal.h"
#include "fs/fake.h"
#include "fs/real.h"
#include "fs/devices.h"
#include "fs/dev.h"
#include "fs/proc.h"
#include "cpu-offsets.h"

extern const struct fs_ops devptsfs;
extern const char *sock_tmp_prefix;
extern __thread volatile sig_atomic_t in_jit;
extern __thread volatile uint64_t jit_saved_pc;
extern void jit_crash_trampoline(void);
extern bool jit_crash_sync(void *context);
extern int do_wait(int type, pid_t_ id, struct siginfo_ *info, struct rusage_ *rusage, int options);

static struct sigaction previous[NSIG];
static void crash_handler(int signal, siginfo_t *info, void *context) {
    if (!pthread_main_np() && in_jit) {
        ucontext_t *uc = context;
        uint64_t cpu = uc->uc_mcontext->__ss.__x[1];
        uint64_t exit_sp = *(uint64_t *)(cpu + LOCAL_jit_exit_sp);
        jit_crash_sync(context);
        *(uint64_t *)(cpu + CPU_segfault_addr) = (uc->uc_mcontext->__ss.__x[7] - uc->uc_mcontext->__ss.__x[10]) & 0xffffffffffffULL;
        *(bool *)(cpu + CPU_segfault_was_write) = (uc->uc_mcontext->__es.__esr & 0x40) != 0;
        *(uint64_t *)(cpu + CPU_pc) = jit_saved_pc;
        uc->uc_mcontext->__ss.__sp = exit_sp;
        uc->uc_mcontext->__ss.__pc = (uint64_t)jit_crash_trampoline;
        return;
    }
    struct sigaction old = previous[signal];
    if (old.sa_handler == SIG_DFL || old.sa_handler == SIG_IGN) {
        sigaction(signal, &old, NULL);
    } else if (old.sa_flags & SA_SIGINFO) old.sa_sigaction(signal, info, context);
    else old.sa_handler(signal);
}
static void install_jit_crash_handler(void) {
    struct sigaction action = {0};
    action.sa_sigaction = crash_handler;
    action.sa_flags = SA_SIGINFO;
    sigemptyset(&action.sa_mask);
    sigaction(SIGSEGV, &action, &previous[SIGSEGV]);
    sigaction(SIGBUS, &action, &previous[SIGBUS]);
}

static _Atomic bool critical_pressure;
static int available_memory(uint64_t *bytes) {
#if TARGET_OS_SIMULATOR
    // Simulator processes have no iOS jetsam allowance; query their host VM.
    vm_statistics64_data_t vm;
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    mach_port_t host = mach_host_self();
    kern_return_t result = host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&vm, &count);
    mach_port_deallocate(mach_task_self(), host);
    if (result != KERN_SUCCESS) return result;
    *bytes = ((uint64_t)vm.free_count + vm.inactive_count) * getpagesize();
#else
    *bytes = os_proc_available_memory();
#endif
    return 0;
}
static void memory_tick(void) {
    task_vm_info_data_t info;
    mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return;
    uint64_t available;
    int result = available_memory(&available);
    if (result) { fprintf(stderr, "iSH memory read failed (stage=linux.memory, code=%d)\n", result); return; }
    ish_set_memory_status(info.phys_footprint + available, available, atomic_load(&critical_pressure));
}
static int memory_start(void) {
    uint64_t available;
    int result = available_memory(&available);
    if (result) return result;
    ish_set_anon_page_limit((long)(available / 2 / getpagesize()));
    dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
    static dispatch_source_t timer, pressure;
    timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC, 25 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(timer, ^{ memory_tick(); });
    dispatch_resume(timer);
    pressure = dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE, 0,
        DISPATCH_MEMORYPRESSURE_NORMAL | DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL, queue);
    dispatch_source_set_event_handler(pressure, ^{
        atomic_store(&critical_pressure, (dispatch_source_get_data(pressure) & DISPATCH_MEMORYPRESSURE_CRITICAL) != 0);
        memory_tick();
    });
    dispatch_resume(pressure);
    memory_tick();
    return 0;
}

struct shell_job {
    uint64_t owner;
    int pid;
    _Atomic int status, launch_error;
    _Atomic bool launched, exited;
    pthread_t launcher;
    char *command, *cwd, *environment;
    int out, err;
    bool retired;
    struct shell_job *next;
};
static struct shell_job *jobs;
static uint64_t next_owner = 1;
static bool owner_live_locked(struct shell_job *job) {
    if (!atomic_load(&job->launched)) return true;
    for (unsigned pid = 2; pid <= MAX_PID; pid++) {
        struct task *task = pid_get_task_zombie(pid);
        if (task && task->group->fs_context == job->owner) return true;
    }
    return false;
}
static void free_job(struct shell_job *job) {
    if (job->launcher) pthread_join(job->launcher, NULL);
    free(job->command); free(job->cwd); free(job->environment); free(job);
}
static void reap_retired_jobs(void) {
    struct shell_job *finished = NULL;
    lock(&pids_lock);
    struct shell_job **entry = &jobs;
    while (*entry) {
        struct shell_job *job = *entry;
        if (job->retired && !owner_live_locked(job)) {
            *entry = job->next; job->next = finished; finished = job;
        } else entry = &job->next;
    }
    unlock(&pids_lock);
    while (finished) { struct shell_job *next = finished->next; free_job(finished); finished = next; }
}

static void process_exit(struct task *task, int code) {
    // iSH invokes exit_hook with pids_lock held, before init may reap the task.
    for (struct shell_job *job = jobs; job; job = job->next) {
        if (task->group->fs_context == job->owner && task->tgid == job->pid) {
            atomic_store(&job->status, (code & 0x7f) ? 128 + (code & 0x7f) : (code >> 8) & 255);
            atomic_store(&job->exited, true);
        }
    }
}

struct boot_data { char *root, *workspace, *dns, *codex; const char *stage; int result; pthread_mutex_t mutex; pthread_cond_t ready; bool done; };
static void *kernel_thread(void *opaque) {
    struct boot_data *boot = opaque;
    @autoreleasepool {
        setenv("ISH_NETLINK_STUB", "1", 1);
        boot->stage = "linux.socket-directory";
#if TARGET_OS_SIMULATOR
        char directory[] = "/tmp/looi-ish-XXXXXX";
        char *created = mkdtemp(directory);
        NSString *prefix = created ? [[NSString stringWithUTF8String:created] stringByAppendingString:@"/is"] : nil;
#else
        NSString *prefix = [NSTemporaryDirectory() stringByAppendingString:@"is"];
#endif
        if ([prefix hasPrefix:@"/private/"]) prefix = [prefix substringFromIndex:8];
        int error = prefix ? 0 : -errno;
        if (!error && strlen(prefix.UTF8String) + 12 >= sizeof(((struct sockaddr_un *)0)->sun_path)) error = -ENAMETOOLONG;
        if (!error) sock_tmp_prefix = strdup(prefix.UTF8String);
        if (!error) {
            install_jit_crash_handler();
            boot->stage = "linux.memory";
            error = memory_start();
        }
        if (!error) {
            boot->stage = "linux.mount-rootfs";
            error = mount_root(&fakefs, boot->root);
        }
        if (!error) {
            boot->stage = "linux.init-process";
            char real[PATH_MAX];
            if (realpath(boot->root, real)) fakefs_set_rootfs_data_path(real);
            error = become_first_process();
            if (!error) current->thread = pthread_self();
        }
        if (!error) {
            generic_mkdirat(AT_PWD, "/dev/pts", 0755);
            generic_mkdirat(AT_PWD, "/workspace", 0755);
            const char *names[] = {"/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom"};
            int minors[] = {DEV_NULL_MINOR, DEV_ZERO_MINOR, DEV_FULL_MINOR, DEV_RANDOM_MINOR, DEV_URANDOM_MINOR};
            for (unsigned i = 0; i < sizeof(minors)/sizeof(minors[0]); i++)
                generic_mknodat(AT_PWD, names[i], S_IFCHR | 0666, dev_make(MEM_MAJOR, minors[i]));
            do_mount(&procfs, "proc", "/proc", "", 0);
            do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
            boot->stage = "linux.mount-workspace";
            error = do_mount(&realfs, boot->workspace, "/workspace", "", 0);
            if (!error) {
                boot->stage = "linux.mount-dns";
                error = fakefs_bind_mount("/etc/resolv.conf", boot->dns, false);
            }
            if (!error) {
                boot->stage = "linux.mount-codex";
                generic_mkdirat(AT_PWD, "/opt", 0755);
                generic_mkdirat(AT_PWD, "/opt/looi", 0755);
                generic_mkdirat(AT_PWD, "/usr/local", 0755);
                generic_mkdirat(AT_PWD, "/usr/local/bin", 0755);
                error = do_mount(&realfs, boot->codex, "/opt/looi", "", 0);
                if (!error) {
                    boot->stage = "linux.link-codex";
                    int removed = generic_unlinkat(AT_PWD, "/usr/local/bin/codex");
                    if (removed && removed != _ENOENT) error = removed;
                    if (!error) error = generic_symlinkat("/opt/looi/codex", AT_PWD, "/usr/local/bin/codex");
                }
            }
            exit_hook = process_exit;
        }
        pthread_mutex_lock(&boot->mutex);
        boot->result = error;
        boot->done = true;
        pthread_cond_signal(&boot->ready);
        pthread_mutex_unlock(&boot->mutex);
        if (error) return NULL;
        // PID 1's pthread remains alive, adopts and reaps every orphan.
        for (;;) {
            struct siginfo_ info = {0};
            do_wait(0, 0, &info, NULL, 1 | 4); // P_ALL, WNOHANG | WEXITED
            reap_retired_jobs();
            usleep(10000);
        }
    }
}
int looi_ish_boot(const char *root, const char *workspace, const char *dns, const char *codex, const char **failed_stage) {
    struct boot_data boot = { .root = strdup(root), .workspace = strdup(workspace), .dns = strdup(dns), .codex = strdup(codex), .stage = "linux.kernel-thread",
        .mutex = PTHREAD_MUTEX_INITIALIZER, .ready = PTHREAD_COND_INITIALIZER };
    pthread_t thread;
    pthread_mutex_lock(&boot.mutex);
    int error = pthread_create(&thread, NULL, kernel_thread, &boot);
    if (!error) {
        pthread_detach(thread);
        while (!boot.done) pthread_cond_wait(&boot.ready, &boot.mutex);
        error = boot.result;
    }
    pthread_mutex_unlock(&boot.mutex);
    *failed_stage = boot.stage;
    free(boot.root); free(boot.workspace); free(boot.dns); free(boot.codex);
    pthread_mutex_destroy(&boot.mutex); pthread_cond_destroy(&boot.ready);
    return error;
}
const char *looi_ish_archive(void) {
    return [[NSBundle.mainBundle pathForResource:@"alpine-fakefs" ofType:@"tar.gz"] fileSystemRepresentation];
}
const char *looi_ish_codex_directory(void) {
    return [[NSBundle.mainBundle pathForResource:@"LinuxTools" ofType:nil] fileSystemRepresentation];
}

static struct fd *host_fd(int number) {
    struct fd *fd = adhoc_fd_create(&realfs_fdops);
    fd->real_fd = number;
    struct stat stat;
    if (fstat(number, &stat) == 0) { fd->stat.mode = stat.st_mode; fd->stat.size = stat.st_size; }
    return fd;
}
static void *launch_command(void *opaque) {
    struct shell_job *job = opaque;
    int error = become_new_init_child();
    if (error < 0) {
        close(job->out); close(job->err);
        atomic_store(&job->launch_error, error);
        atomic_store(&job->launched, true);
        atomic_store(&job->exited, true);
        return NULL;
    }
    lock(&pids_lock);
    job->pid = current->pid;
    current->group->fs_context = job->owner;
    unlock(&pids_lock);
    current->files->files[0] = host_fd(open("/dev/null", O_RDONLY));
    current->files->files[1] = host_fd(job->out);
    current->files->files[2] = host_fd(job->err);
    struct fd *cwd = generic_open(job->cwd, O_RDONLY_ | O_DIRECTORY_, 0);
    if (IS_ERR(cwd)) error = PTR_ERR(cwd);
    else { fs_chdir(current->fs, cwd); }
    size_t length = strlen(job->command);
    char *argv = malloc(length + 13);
    memcpy(argv, "/bin/sh\0-c\0", 11);
    memcpy(argv + 11, job->command, length + 1);
    argv[length + 12] = 0;
    if (!error) error = do_execve("/bin/sh", 3, argv, job->environment);
    free(argv);
    atomic_store(&job->launch_error, error);
    if (error < 0) {
        current->thread = pthread_self();
        atomic_store(&job->launched, true);
        do_exit(127 << 8);
    }
    error = task_start(current);
    atomic_store(&job->launch_error, error);
    if (error < 0) current->thread = pthread_self();
    atomic_store(&job->launched, true);
    if (error < 0) do_exit(127 << 8);
    current = NULL;
    return NULL;
}
void *looi_ish_start(const char *command, const char *cwd, const char *env, size_t env_len, int out, int err) {
    struct shell_job *job = calloc(1, sizeof(*job));
    job->command = strdup(command); job->cwd = strdup(cwd);
    job->environment = malloc(env_len); memcpy(job->environment, env, env_len);
    job->out = out; job->err = err;
    lock(&pids_lock);
    job->owner = next_owner++; job->next = jobs; jobs = job;
    unlock(&pids_lock);
    int error = pthread_create(&job->launcher, NULL, launch_command, job);
    if (error) { job->launcher = 0; close(out); close(err); atomic_store(&job->launch_error, -error); atomic_store(&job->launched, true); atomic_store(&job->exited, true); }
    return job;
}
int looi_ish_poll(void *opaque, int *status) {
    struct shell_job *job = opaque;
    if (!atomic_load(&job->launched)) return 0;
    int error = atomic_load(&job->launch_error);
    if (error < 0) return error;
    if (!atomic_load(&job->exited)) return 0;
    *status = atomic_load(&job->status);
    return 1;
}
int looi_ish_signal(void *opaque, int signal) {
    struct shell_job *job = opaque;
    if (!atomic_load(&job->launched)) return 1;
    int live = 0;
    lock(&pids_lock);
    for (unsigned pid = 2; pid <= MAX_PID; pid++) {
        struct task *task = pid_get_task_zombie(pid);
        if (!task || task->group->fs_context != job->owner) continue;
        live++;
        if (signal && !task->zombie) send_signal(task, signal, SIGINFO_NIL);
    }
    unlock(&pids_lock);
    return live;
}
void looi_ish_release(void *opaque) {
    struct shell_job *job = opaque;
    lock(&pids_lock);
    if (owner_live_locked(job)) {
        job->retired = true;
        unlock(&pids_lock);
        return;
    }
    struct shell_job **entry = &jobs;
    while (*entry && *entry != job) entry = &(*entry)->next;
    if (*entry) *entry = job->next;
    unlock(&pids_lock);
    free_job(job);
}
