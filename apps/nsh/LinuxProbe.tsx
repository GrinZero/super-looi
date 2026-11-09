import { cleanup, mount, Scroll, signal, Text, View } from "nsh";
import { NodeCompat } from "super-looi/native";
import { installNshNativeCompat, utf8Tail } from "./generated/linux-probe.js";
import { verifyLinuxShell } from "./generated/linux-probe.js";
import { TaskShellOutput } from "./ui/TaskShellOutput";
import type { NativeShellOutput } from "./generated/looi-runtime.js";

function LinuxProbe() {
  const status = signal("Testing Linux Shell");
  const shell = signal<{taskId:string;callId:string;command:string;text:string;status:string}|undefined>(undefined);
  const host = new NodeCompat();
  const release = installNshNativeCompat(host);
  cleanup(release);
  const output = (event: NativeShellOutput) => {
    const old = shell();
    const current = old?.callId === event.callId && old.taskId === event.taskId
      ? old : {taskId:event.taskId,callId:event.callId,command:event.command,text:"",status:""};
    shell.set({...current,...(event.stream === "status" ? {status:event.chunk} : {text:utf8Tail(current.text+event.chunk,16384)})});
  };
  void verifyLinuxShell(output).then(() => {
    console.log("Linux Shell verified"); status.set("Linux Shell verified");
  }, error => {
    console.log(`Linux Shell failed: ${String(error)}`); status.set(`Linux Shell failed: ${String(error)}`);
  });
  return <Scroll class="flex-1 bg-background"><View class="p-4 gap-4">
    <Text class="text-foreground text-lg">{status()}</Text>
    <TaskShellOutput output={shell()} taskId={shell()?.taskId}/>
  </View></Scroll>;
}
mount(LinuxProbe);
