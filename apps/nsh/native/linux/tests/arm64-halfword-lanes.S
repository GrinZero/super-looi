// Freestanding Linux guest regression for LD1/ST1 halfword lane decoding.
// Build: clang --target=aarch64-linux-musl -nostdlib -static -fuse-ld=lld
//        -Wl,-e,_start arm64-halfword-lanes.S -o arm64-halfword-lanes
// Run in the App Linux guest. Exit bits: 1 = load, 2 = store.
.text
.global _start
_start:
    adrp x0, input
    add x0, x0, :lo12:input
    mov x4, #2
    mov x19, #0
    movi v0.16b, #0
    ld1 {v0.h}[0], [x0], #2
    ld1 {v0.h}[1], [x0], x4
    ld1 {v0.h}[2], [x0]
    add x0, x0, #2
    ld1 {v0.h}[3], [x0], #2
    ld1 {v0.h}[4], [x0], x4
    ld1 {v0.h}[5], [x0]
    add x0, x0, #2
    ld1 {v0.h}[6], [x0], #2
    ld1 {v0.h}[7], [x0]
    adrp x1, output
    add x1, x1, :lo12:output
    str q0, [x1]
    bl compare
    orr x19, x19, x2

    adrp x0, input
    add x0, x0, :lo12:input
    ldr q0, [x0]
    adrp x1, output
    add x1, x1, :lo12:output
    stp xzr, xzr, [x1]
    st1 {v0.h}[0], [x1], #2
    st1 {v0.h}[1], [x1], x4
    st1 {v0.h}[2], [x1]
    add x1, x1, #2
    st1 {v0.h}[3], [x1], #2
    st1 {v0.h}[4], [x1], x4
    st1 {v0.h}[5], [x1]
    add x1, x1, #2
    st1 {v0.h}[6], [x1], #2
    st1 {v0.h}[7], [x1]
    bl compare
    orr x19, x19, x2, lsl #1
    cbnz x19, failed
    adrp x1, pass
    add x1, x1, :lo12:pass
    mov x2, #pass_len
    b finish
failed:
    adrp x1, fail
    add x1, x1, :lo12:fail
    mov x2, #fail_len
finish:
    mov x0, #1
    mov x8, #64
    svc #0
    mov x0, x19
    mov x8, #93
    svc #0
compare:
    adrp x0, input
    add x0, x0, :lo12:input
    adrp x1, output
    add x1, x1, :lo12:output
    ldp x5, x6, [x0]
    ldp x7, x8, [x1]
    cmp x5, x7
    ccmp x6, x8, #0, eq
    cset x2, ne
    ret
.section .rodata
.balign 16
input: .hword 0x1101, 0x2202, 0x3303, 0x4404, 0x5505, 0x6606, 0x7707, 0x8808
pass: .ascii "ARM64 halfword lanes PASS\n"
.equ pass_len, .-pass
fail: .ascii "ARM64 halfword lanes FAIL\n"
.equ fail_len, .-fail
.bss
.balign 16
output: .skip 16
