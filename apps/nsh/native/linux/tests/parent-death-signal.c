// Build with an aarch64 Linux musl toolchain; run in the Linux guest.
// Exercises the pre-exec prctl used by the official Codex process spawner.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static void check(int ok, const char *stage) {
    if (!ok) {
        int error = errno;
        char number[12];
        unsigned length = 0;
        do { number[length++] = '0' + error % 10; error /= 10; } while (error);
        write(2, stage, strlen(stage));
        write(2, ": errno=", 8);
        while (length) write(2, &number[--length], 1);
        write(2, "\n", 1);
        exit(1);
    }
}

static int wait_ok(pid_t pid) {
    int status;
    return waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static int get_signal(void) {
    int sig = -1;
    check(prctl(PR_GET_PDEATHSIG, &sig) == 0, "GET_PDEATHSIG");
    return sig;
}

static int report_fd;
struct receiver_args {int ready_fd, mode; pthread_t leader;};
static void parent_died(int sig, siginfo_t *info, void *context) {
    (void) context;
    int report[2] = {sig, info->si_pid};
    _exit(write(report_fd, report, sizeof(report)) == sizeof(report) ? 0 : 2);
}

static void *receiving_thread(void *ready_fd) {
    struct receiver_args *args = ready_fd;
    if (args->mode >= 2)
        check(prctl(PR_SET_PDEATHSIG, SIGTERM) == 0, "worker registers PDEATHSIG");
    if (args->mode == 3)
        check(pthread_join(args->leader, NULL) == 0, "join exited leader");
    sigset_t signals;
    sigemptyset(&signals);
    sigaddset(&signals, SIGTERM);
    check(pthread_sigmask(SIG_UNBLOCK, &signals, NULL) == 0, "worker unblocks SIGTERM");
    check(write(args->ready_fd, "R", 1) == 1, "worker ready write");
    for (;;) pause();
}

static void spawn_waiting_child(int thread_receiver) {
    int ready[2];
    check(pipe(ready) == 0, "ready pipe");
    pid_t parent_pid = getpid();
    pid_t child = fork();
    check(child >= 0, "parent-death fork");
    if (child == 0) {
        check(getppid() == parent_pid, "getppid returns parent process ID, not creating thread ID");
        close(ready[0]);
        struct sigaction action = {.sa_sigaction = parent_died, .sa_flags = SA_SIGINFO};
        sigemptyset(&action.sa_mask);
        check(sigaction(SIGTERM, &action, NULL) == 0, "SIGTERM handler");
        if (thread_receiver < 2)
            check(prctl(PR_SET_PDEATHSIG, SIGTERM) == 0, "SET_PDEATHSIG child");
        alarm(5);
        if (thread_receiver) {
            sigset_t signals;
            sigemptyset(&signals);
            sigaddset(&signals, SIGTERM);
            check(pthread_sigmask(SIG_BLOCK, &signals, NULL) == 0, "leader blocks SIGTERM");
            struct receiver_args *args = malloc(sizeof(*args));
            check(args != NULL, "receiver args");
            *args = (struct receiver_args) {ready[1], thread_receiver, pthread_self()};
            pthread_t thread;
            check(pthread_create(&thread, NULL, receiving_thread, args) == 0, "receiver thread create");
            if (thread_receiver == 3)
                pthread_exit(NULL);
        } else {
            check(write(ready[1], "R", 1) == 1, "ready write");
        }
        for (;;) pause();
    }
    close(ready[1]);
    char byte;
    check(read(ready[0], &byte, 1) == 1, "ready read");
    close(ready[0]);
}

static void *forking_thread(void *unused) {
    (void) unused;
    spawn_waiting_child(0);
    return NULL;
}

static void test_parent_exit(int thread_parent, int thread_receiver) {
    int report[2], control[2];
    check(pipe(report) == 0, "report pipe");
    check(pipe(control) == 0, "control pipe");
    pid_t parent = fork();
    check(parent >= 0, "test parent fork");
    if (parent == 0) {
        close(report[0]);
        close(control[1]);
        report_fd = report[1];
        if (thread_parent) {
            pthread_t thread;
            check(pthread_create(&thread, NULL, forking_thread, NULL) == 0, "parent thread create");
            check(pthread_join(thread, NULL) == 0, "parent thread join");
            close(report_fd);
            // Stay alive until the supervisor observes the grandchild's signal.
            char byte;
            check(read(control[0], &byte, 1) == 1, "parent exit release");
        } else {
            spawn_waiting_child(thread_receiver);
        }
        _exit(0);
    }
    close(report[1]);
    close(control[0]);
    int result[2] = {0};
    check(read(report[0], result, sizeof(result)) == sizeof(result), "parent-death report");
    check(result[0] == SIGTERM && result[1] == parent, "parent-death signal and sender PID");
    if (thread_parent) {
        int status;
        check(waitpid(parent, &status, WNOHANG) == 0, "signal arrives before parent process exit");
        check(write(control[1], "X", 1) == 1, "release parent");
    }
    close(control[1]);
    close(report[0]);
    check(wait_ok(parent), "test parent exit");
}

static void test_setid_exec(const char *executable) {
    const char *copy = "/tmp/looi-pdeath-exec-fixture";
    int source = open(executable, O_RDONLY);
    check(source >= 0, "open executable");
    int target = open(copy, O_CREAT | O_TRUNC | O_RDWR, 0700);
    check(target >= 0, "create set-ID fixture");
    char buffer[4096];
    ssize_t count;
    while ((count = read(source, buffer, sizeof(buffer))) > 0)
        check(write(target, buffer, count) == count, "copy set-ID executable");
    check(count == 0, "read executable");
    close(source);
    close(target);
    for (int changed = 0; changed <= 3; changed++) {
        check(chown(copy, changed ? 1000 : geteuid(), getegid()) == 0, "set fixture owner");
        check(chmod(copy, changed == 3 ? 0755 : 04755) == 0, "set fixture mode");
        pid_t child = fork();
        check(child >= 0, "set-ID exec fork");
        if (child == 0) {
            if (changed >= 2)
                check(setresuid(-1, 1000, -1) == 0, "set distinct real/effective UID");
            check(prctl(PR_SET_PDEATHSIG, SIGUSR1) == 0, "set before set-ID exec");
            execl(copy, copy, changed ? "--after-setid-change" : "--after-exec", NULL);
            check(0, "set-ID exec");
        }
        check(wait_ok(child), changed ? "changed owner clears signal" : "same owner preserves signal");
    }
    check(unlink(copy) == 0, "remove set-ID fixture");
    puts("PDEATHSIG set-ID and distinct real/effective UID exec PASS");
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc == 2 && strcmp(argv[1], "--after-exec") == 0) {
        check(get_signal() == SIGUSR1, "exec preserves parent-death signal");
        return 0;
    }
    if (argc == 2 && strcmp(argv[1], "--after-setid-change") == 0) {
        check(get_signal() == 0, "set-ID exec clears parent-death signal");
        return 0;
    }
    check(get_signal() == 0, "initial signal");
    errno = 0;
    check(prctl(PR_SET_PDEATHSIG, -1) == -1 && errno == EINVAL, "invalid negative signal");
    errno = 0;
    check(prctl(PR_SET_PDEATHSIG, 65) == -1 && errno == EINVAL, "invalid signal 65");
    errno = 0;
    check(prctl(PR_GET_PDEATHSIG, NULL) == -1 && errno == EFAULT, "invalid GET address");
    check(prctl(PR_SET_PDEATHSIG, SIGUSR1) == 0 && get_signal() == SIGUSR1, "set/get signal");
    pid_t child = fork();
    check(child >= 0, "fork reset");
    if (child == 0) {
        check(get_signal() == 0, "fork resets signal");
        check(prctl(PR_SET_PDEATHSIG, SIGUSR1) == 0, "set before exec");
        execl(argv[0], argv[0], "--after-exec", NULL);
        check(0, "exec self");
    }
    check(wait_ok(child), "fork and exec child");
    check(prctl(PR_SET_PDEATHSIG, 0) == 0 && get_signal() == 0, "clear signal");
    puts("PDEATHSIG set/get, fork reset, exec preservation PASS");
    test_parent_exit(0, 0);
    test_parent_exit(1, 0);
    test_parent_exit(0, 1);
    test_parent_exit(0, 2);
    test_parent_exit(0, 3);
    puts("PDEATHSIG parent process/thread exit and worker delivery PASS");
    child = fork();
    check(child >= 0, "credential child fork");
    if (child == 0) {
        check(prctl(PR_SET_PDEATHSIG, SIGUSR1) == 0, "set before credentials");
        check(setresgid(-1, 1000, -1) == 0 && get_signal() == 0, "effective GID clears signal");
        check(prctl(PR_SET_PDEATHSIG, SIGUSR1) == 0, "set before UID");
        check(setresuid(-1, 1000, -1) == 0 && get_signal() == 0, "effective UID clears signal");
        _exit(0);
    }
    check(wait_ok(child), "credential child exit");
    puts("PDEATHSIG credential changes PASS");
    test_setid_exec(argv[0]);
    return 0;
}
