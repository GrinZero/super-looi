/** Self-contained device surface; no external font, image or script dependencies. */
export function getConsoleHtml(): string {
  return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#03070D" />
    <title>LOOI · Presence v3.0</title>
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%2303070D'/%3E%3Cg fill='%2328D5FF'%3E%3Crect x='5' y='9' width='8' height='11' rx='4'/%3E%3Crect x='19' y='9' width='8' height='11' rx='4'/%3E%3C/g%3E%3C/svg%3E"
    />
    <style>
      :root {
        color-scheme: dark;
        --deep: #03070d;
        --raised: #07111d;
        --glass: rgba(10, 22, 36, 0.78);
        --elevated: rgba(16, 34, 54, 0.88);
        --line: rgba(84, 167, 255, 0.2);
        --active: rgba(40, 213, 255, 0.75);
        --cyan: #28d5ff;
        --blue: #1f7cff;
        --green: #4ade80;
        --amber: #f3c56b;
        --coral: #fa8e86;
        --text: #edf7ff;
        --secondary: #9bb0c4;
        --muted: #647b90;
        --gx: 0px;
        --gy: 0px;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--deep);
        color: var(--text);
        font:
          14px/1.6 -apple-system,
          BlinkMacSystemFont,
          "PingFang SC",
          "Microsoft YaHei",
          sans-serif;
      }
      button,
      input,
      select {
        font: inherit;
      }
      button {
        cursor: pointer;
        color: inherit;
        background: var(--glass);
        border: 1px solid var(--line);
        border-radius: 14px;
        min-height: 44px;
        padding: 10px 16px;
        transition:
          background 0.18s,
          transform 0.18s,
          border-color 0.18s;
      }
      button:hover {
        background: var(--elevated);
        border-color: var(--active);
      }
      button:active {
        transform: scale(0.97);
        opacity: 0.78;
      }
      button:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
      button:focus-visible,
      input:focus-visible,
      select:focus-visible {
        outline: 2px solid var(--cyan);
        outline-offset: 4px;
      }
      button svg {
        flex-shrink: 0;
      }
      input,
      select {
        background: var(--deep);
        border: 1px solid var(--line);
        border-radius: 12px;
        color: var(--text);
        min-height: 44px;
        padding: 10px 12px;
        max-width: 100%;
      }
      input[type="range"] {
        padding: 0;
        accent-color: var(--blue);
        width: 100%;
      }
      h1,
      h2,
      h3,
      p {
        margin: 0;
      }
      h1 {
        font-size: 28px;
        letter-spacing: -1px;
        font-weight: 600;
      }
      h2 {
        font-size: 19px;
        font-weight: 600;
      }
      h3 {
        font-size: 17px;
        font-weight: 600;
      }
      p {
        color: var(--secondary);
      }
      small,
      .caption {
        font-size: 12px;
        color: var(--secondary);
      }
      [hidden] {
        display: none !important;
      }
      .icon {
        width: 22px;
        height: 22px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
        vertical-align: middle;
      }
      .row {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .spread {
        justify-content: space-between;
      }
      .muted {
        color: var(--muted);
      }
      .amber {
        color: var(--amber);
      }
      .green {
        color: var(--green);
      }
      .coral {
        color: var(--coral);
      }
      .danger {
        color: var(--coral);
        border-color: rgba(250, 142, 134, 0.4);
      }
      .tag {
        font-size: 12px;
        border: 1px solid var(--line);
        padding: 3px 9px;
        border-radius: 8px;
        display: inline-block;
      }
      .mono {
        font-family: "SFMono-Regular", Consolas, monospace;
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      .glass {
        background: var(--glass);
        border: 1px solid var(--line);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
      }
      .screen {
        min-height: 100dvh;
        background-image: radial-gradient(rgba(84, 167, 255, 0.13) 0.75px, transparent 0.9px);
        background-size: 22px 22px;
      }
      .ambient {
        height: 100dvh;
        min-height: 360px;
        position: relative;
        overflow: hidden;
        isolation: isolate;
      }
      .face-hit {
        position: absolute;
        inset: 0;
        border: 0;
        background: transparent;
        border-radius: 0;
      }
      .face-hit:hover {
        background: transparent;
      }
      .face-hit:active {
        transform: none;
      }
      .corners {
        position: absolute;
        z-index: 2;
        top: max(24px, env(safe-area-inset-top));
        left: max(28px, env(safe-area-inset-left));
        right: max(28px, env(safe-area-inset-right));
        display: flex;
        justify-content: space-between;
        gap: 16px;
        pointer-events: none;
      }
      .corners > * {
        pointer-events: auto;
      }
      .capsule {
        border-radius: 30px;
        display: inline-flex;
        align-items: center;
        gap: 9px;
        padding: 8px 16px;
        min-height: 44px;
        font-size: 13px;
      }
      .perception {
        color: var(--secondary);
        font-size: 12px;
        background: rgba(10, 22, 36, 0.38);
        max-width: 46%;
      }
      .dot {
        width: 5px;
        height: 5px;
        border-radius: 100%;
        background: currentColor;
        display: inline-block;
        flex-shrink: 0;
      }
      .face {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 570px;
        height: 310px;
        transform: translate(-50%, -48%);
        pointer-events: none;
        transition: transform 0.5s;
      }
      .aura {
        position: absolute;
        inset: -60px -80px;
        background: radial-gradient(ellipse, rgba(31, 124, 255, 0.12), transparent 64%);
        animation: breathe 6s ease-in-out infinite;
      }
      .aura.inner {
        inset: -30px 10px;
        background: radial-gradient(ellipse, rgba(40, 213, 255, 0.1), transparent 66%);
        animation-delay: -3s;
      }
      .eyes {
        position: absolute;
        top: 45px;
        left: 64px;
        display: flex;
        gap: 138px;
        transform: translate(var(--gx), var(--gy));
        transition: transform 0.3s ease-out;
      }
      .orb {
        width: 144px;
        height: 144px;
        background: linear-gradient(175deg, #65e9ff 0%, var(--cyan) 45%, #1dadfa 83%, #0066ff 100%);
        border-radius: 50%;
        box-shadow:
          inset 0 -9px 0 #0066ff,
          inset 0 3px 9px rgba(237, 247, 255, 0.35),
          0 0 28px rgba(40, 213, 255, 0.36),
          0 0 80px rgba(31, 124, 255, 0.25);
        transition:
          transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
          opacity 0.18s ease-out,
          background 0.35s,
          border-radius 0.35s;
        position: relative;
      }
      .brow {
        position: absolute;
        left: 24px;
        top: -29px;
        width: 102px;
        height: 14px;
        border-top: 4px solid var(--cyan);
        border-radius: 50%;
        opacity: 0.58;
        transition: transform 0.45s;
      }
      .orb:nth-child(2) .brow {
        transform: rotate(3deg);
      }
      .mouth {
        position: absolute;
        left: calc(50% - 30px);
        top: 222px;
        width: 60px;
        height: 30px;
        border-bottom: 4px solid var(--cyan);
        border-radius: 0 0 50% 50%;
        filter: drop-shadow(0 0 9px rgba(40, 213, 255, 0.35));
        transition: width 0.3s;
      }
      .waves {
        position: absolute;
        left: 50%;
        top: 223px;
        transform: translateX(-50%);
        height: 36px;
        display: none;
        align-items: center;
        gap: 6px;
      }
      .waves i {
        height: 9px;
        width: 5px;
        background: var(--cyan);
        border-radius: 4px;
        animation: voice 0.52s ease-in-out infinite alternate;
        animation-delay: calc(var(--i) * -0.13s);
      }
      .speaking .waves {
        display: flex;
      }
      .speaking .mouth {
        display: none;
      }
      .speaking .brow {
        transform: translateY(-6px);
      }
      .sleeping .orb {
        height: 4px;
        margin: 98px 0;
        border-radius: 3px;
        opacity: 0.45;
        transition: opacity 0.2s ease-out;
      }
      .sleeping .orb::after {
        display: none;
      }
      .sleeping .brow,
      .sleeping .mouth {
        opacity: 0;
      }
      .thinking .orb:first-child .brow {
        transform: rotate(-12deg) translateY(-6px);
      }
      .thinking .mouth {
        height: 0;
        width: 30px;
        left: calc(50% - 15px);
        border-radius: 8px;
      }
      .curious .orb:nth-child(2) .brow {
        transform: translateY(-12px) rotate(-9deg);
      }
      .alarmed .orb {
        background: var(--coral);
        box-shadow:
          inset 0 -8px 0 rgba(250, 142, 134, 0.45),
          0 0 50px rgba(250, 142, 134, 0.3);
      }
      .alarmed .brow {
        border-color: var(--coral);
        transform: rotate(12deg);
      }
      .blinking:not(.sleeping) .orb {
        --blink-scale: 0.92;
        opacity: 0.65;
      }
      .wake {
        position: absolute; bottom: max(28px, env(safe-area-inset-bottom)); left: 50%;
        transform: translateX(-50%); display: flex; align-items: center; justify-content: center;
        gap: 24px; width: max-content; max-width: 94%; padding: 14px 8px; z-index: 2;
        border: 0; background: transparent; color: #9BB0C4; font-size: 17px; letter-spacing: 1px;
        transition: opacity .3s, transform .3s;
      }
      .wake:hover { background: transparent; }
      .wake[hidden] { display: none; }
      .wake .hey { color: #2B88FF; font-weight: 600; }
      .wake .parenthesis { color: #20599b; font-size: 30px; font-weight: 200; }
      .wake:after { content: ""; position: absolute; width: 85vw; height: 80px; bottom: -62px;
        background: radial-gradient(ellipse, rgba(31,124,255,.32), transparent 70%); pointer-events: none; }
      .drawer-open .wake, .lab-open .wake { opacity: 0 !important; pointer-events: none; transform: translateX(-50%) translateY(12px); }
      .privacy-card {
        position: absolute;
        left: 50%;
        bottom: 19%;
        transform: translateX(-50%);
        text-align: center;
        max-width: 90%;
        width: 440px;
        border-radius: 20px;
        padding: 20px;
        pointer-events: none;
      }
      .privacy-card p {
        margin-top: 6px;
        font-size: 13px;
      }
      .motion-stop {
        position: absolute;
        left: 50%;
        bottom: 105px;
        transform: translateX(-50%);
        background: var(--coral);
        color: var(--deep);
        font-weight: 600;
        z-index: 4;
      }
      .motion-stop:hover {
        background: var(--coral);
      }
      .motion-stop:active {
        transform: translateX(-50%) scale(0.97);
      }
      .ask-bar {
        position: absolute;
        top: 68px;
        left: 50%;
        transform: translateX(-50%);
        width: min(560px, 92vw);
        display: flex;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 999px;
        z-index: 5;
      }
      .ask-bar[hidden] {
        display: none;
      }
      .ask-bar input {
        flex: 1;
        border: 0;
        background: transparent;
        color: var(--text);
        padding: 6px 12px;
        outline: none;
      }
      .ask-bar button {
        border-radius: 999px;
        padding: 6px 16px;
        background: #2b88ff;
        color: #fff;
        border: 0;
        font-weight: 600;
      }
      .capsule.live-active {
        border-color: var(--green);
        color: var(--green);
        background: rgba(16, 48, 36, 0.72);
      }
      .toast {
        position: fixed;
        top: max(84px, env(safe-area-inset-top));
        left: 50%;
        transform: translateX(-50%);
        z-index: 12;
        border-radius: 24px;
        padding: 11px 22px;
        max-width: min(640px, 85vw);
        font-size: 14px;
        box-shadow: 0 12px 50px rgba(0, 0, 0, 0.3);
        text-align: center;
        pointer-events: none;
      }
      .sheet-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(3, 7, 13, 0.28);
        z-index: 8;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding: 24px;
      }
      .sheet {
        width: min(940px, 100%);
        border-radius: 28px;
        padding: 23px;
        box-shadow: 0 -20px 80px rgba(0, 0, 0, 0.24);
        animation: rise 0.25s ease-out;
      }
      .sheet .handle {
        margin: -10px auto 16px;
        width: 45px;
        height: 3px;
        background: var(--muted);
        border-radius: 3px;
      }
      .sheet-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 10px;
        margin-top: 18px;
      }
      .sheet-item {
        min-height: 96px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        gap: 12px;
        background: rgba(16, 34, 54, 0.4);
        font-size: 13px;
      }
      .sheet-item .icon {
        height: 26px;
        width: 26px;
      }
      .close {
        padding: 8px;
        min-width: 44px;
        background: transparent;
      }
      .shell {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr);
        min-height: 100dvh;
        background-color: rgba(7, 17, 29, 0.6);
      }
      .rail {
        width: 88px;
        position: sticky;
        top: 0;
        height: 100dvh;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 22px 8px;
        border-width: 0 1px 0 0;
      }
      .rail button {
        width: 70px;
        min-height: 66px;
        padding: 8px 2px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        border-color: transparent;
        background: transparent;
      }
      .rail .brand {
        font-family: "Avenir Next", sans-serif;
        letter-spacing: 2px;
        font-weight: 600;
        font-size: 16px;
        margin-bottom: 22px;
      }
      .rail button[aria-current="page"] {
        border-color: var(--active);
        background: var(--elevated);
      }
      .rail .rail-bottom {
        margin-top: auto;
      }
      .workspace {
        min-width: 0;
        padding: 28px clamp(18px, 3vw, 48px) 18px;
      }
      .space-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 20px;
        padding-bottom: 24px;
      }
      .space-header p {
        margin-top: 4px;
        font-size: 13px;
      }
      .anchor {
        display: inline-flex;
        gap: 5px;
        vertical-align: middle;
        margin-left: 14px;
      }
      .anchor i {
        width: 5px;
        height: 11px;
        border-radius: 6px;
        background: var(--cyan);
        box-shadow: 0 0 12px rgba(40, 213, 255, 0.4);
      }
      .mini {
        position: relative;
        width: 108px;
        height: 66px;
        flex-shrink: 0;
        border-radius: 23px;
        background: var(--elevated);
        box-shadow: inset 0 0 20px rgba(31, 124, 255, 0.1);
        padding: 0;
      }
      .mini:before,
      .mini:after {
        content: "";
        width: 3px;
        height: 20px;
        background: var(--blue);
        position: absolute;
        top: 21px;
        left: -5px;
        border-radius: 3px;
      }
      .mini:after {
        left: auto;
        right: -5px;
      }
      .mini-inner {
        position: absolute;
        left: 21px;
        top: 17px;
        display: flex;
        gap: 24px;
        transform: translate(var(--mx, 0px), var(--my, 0px));
        transition: transform 0.4s;
      }
      .mini-eye {
        width: 20px;
        height: 20px;
        background: var(--cyan);
        border-radius: 50%;
        box-shadow: 0 0 12px rgba(40, 213, 255, 0.3);
      }
      .mini-mouth {
        position: absolute;
        width: 15px;
        height: 8px;
        bottom: 11px;
        left: 46px;
        border-bottom: 2px solid var(--cyan);
        border-radius: 50%;
      }
      .columns {
        display: grid;
        grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
        gap: 22px;
      }
      .stack {
        display: grid;
        gap: 14px;
        align-content: start;
      }
      .card {
        border-radius: 20px;
        padding: 22px;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .card h2,
      .card h3 {
        margin-bottom: 8px;
      }
      .card p + p {
        margin-top: 8px;
      }
      .card .row {
        margin-top: 14px;
      }
      .select-card {
        width: 100%;
        text-align: left;
        display: block;
      }
      .select-card.selected {
        border-color: var(--active);
        background: var(--elevated);
      }
      .select-card .row {
        margin: 0 0 8px;
      }
      .filters {
        margin-bottom: 18px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .filters input {
        flex: 1;
        min-width: 140px;
      }
      .filters button {
        font-size: 12px;
        padding: 8px 12px;
      }
      .filters button[aria-pressed="true"] {
        background: var(--elevated);
        border-color: var(--active);
      }
      .scene {
        width: 100%;
        height: 190px;
        margin: 8px 0 16px;
        background: radial-gradient(ellipse, rgba(31, 124, 255, 0.09), transparent);
        border: 1px solid var(--line);
        border-radius: 14px;
      }
      .questions {
        display: grid;
        grid-template-columns: 60px 1fr;
        gap: 12px;
        margin: 16px 0;
      }
      .questions dt {
        color: var(--muted);
        font:
          12px/1.8 "SFMono-Regular",
          Consolas,
          monospace;
      }
      .questions dd {
        margin: 0;
        color: var(--secondary);
      }
      .divider {
        height: 1px;
        background: var(--line);
        margin: 18px 0;
      }
      .empty {
        padding: 34px 20px;
        color: var(--secondary);
        text-align: center;
        border: 1px dashed var(--line);
        border-radius: 18px;
      }
      .footer {
        margin-top: 24px;
        padding-top: 14px;
        border-top: 1px solid var(--line);
        font-size: 12px;
        color: var(--muted);
        display: flex;
        justify-content: space-between;
        gap: 14px;
        flex-wrap: wrap;
      }
      .bento {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }
      .bento .card {
        min-height: 225px;
      }
      .cap-icon {
        display: flex;
        width: 44px;
        height: 44px;
        align-items: center;
        justify-content: center;
        background: rgba(84, 167, 255, 0.07);
        border-radius: 14px;
        margin-bottom: 14px;
      }
      .sensor-value {
        font-size: 30px;
        color: var(--text);
        font-variant-numeric: tabular-nums;
        letter-spacing: -1px;
      }
      .connections {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
        margin-bottom: 20px;
      }
      .connections .card {
        min-height: 180px;
      }
      .connection-state {
        margin: 15px 0;
        font-size: 18px;
      }
      .engine-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
        margin-bottom: 20px;
      }
      .options {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 14px;
      }
      .options button.selected {
        border-color: var(--active);
      }
      .acceptance-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-top: 20px;
      }
      .acceptance-group {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
      }
      .case-list {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 5px;
        margin-top: 10px;
      }
      .case {
        font-size: 12px;
        padding: 6px 2px;
        text-align: center;
        border-radius: 6px;
        background: rgba(84, 167, 255, 0.05);
        color: var(--muted);
      }
      .case.pass {
        color: var(--green);
        background: rgba(74, 222, 128, 0.07);
      }
      .case.fail {
        color: var(--coral);
        background: rgba(250, 142, 134, 0.08);
      }
      .gate-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-top: 16px;
      }
      .gate {
        font-size: 12px;
        color: var(--secondary);
        border-top: 1px solid var(--line);
        padding-top: 12px;
      }
      .gate strong {
        display: block;
        font-size: 23px;
        font-weight: 500;
      }
      .cutoff {
        margin-bottom: 18px;
        color: var(--amber);
        padding: 12px 16px;
        border-radius: 14px;
      }
      .error-banner {
        margin-bottom: 18px;
        color: var(--coral);
        padding: 12px 16px;
        border: 1px solid var(--line);
        border-radius: 14px;
      }
      .inline-form {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 14px;
      }
      .inline-form input {
        flex: 1;
        min-width: 130px;
      }
      .task-state {
        border-left: 2px solid var(--amber);
        padding-left: 12px;
        margin: 12px 0;
      }
      .details {
        font-size: 13px;
        color: var(--secondary);
      }
      .details summary {
        min-height: 44px;
        cursor: pointer;
        padding-top: 10px;
      }
      .details pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 12px;
      }
      .rule {
        padding: 14px 0;
        border-bottom: 1px solid var(--line);
      }
      .rule:last-child {
        border-bottom: 0;
      }
      .subtitle {
        position: absolute;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 22px;
        border-radius: 22px;
        max-width: 85%;
        font-size: 14px;
      }
      @keyframes breathe {
        50% {
          opacity: 0.45;
          transform: scale(0.93);
        }
      }
      @keyframes voice {
        to {
          height: calc(13px + var(--i) * 4px);
        }
      }
      @keyframes rise {
        from {
          opacity: 0;
          transform: translateY(24px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @media (max-width: 900px) {
        .workspace {
          padding: 22px;
        }
        .columns {
          gap: 14px;
        }
        .card {
          padding: 18px;
        }
        .sheet-grid {
          grid-template-columns: repeat(3, 1fr);
        }
        .sheet-item {
          min-height: 80px;
        }
        .acceptance-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @media (max-width: 650px) {
        .corners {
          left: 16px;
          right: 16px;
          top: 16px;
          gap: 8px;
        }
        .corners .row {
          gap: 6px;
        }
        .capsule {
          padding: 8px 12px;
        }
        .perception {
          font-size: 12px;
          max-width: 45%;
        }
        .face {
          transform: translate(-50%, -48%) scale(0.65);
        }
        .drawer-open .face {
          transform: translate(-50%, -80%) scale(0.55);
        }
        .sheet-backdrop {
          padding: 10px;
        }
        .sheet {
          padding: 18px;
        }
        .sheet-grid {
          gap: 8px;
        }
        .sheet-item {
          font-size: 12px;
          min-height: 76px;
          gap: 8px;
        }
        .sheet h2 {
          font-size: 17px;
        }
        .shell {
          grid-template-columns: 1fr;
          padding-bottom: 82px;
        }
        .rail {
          position: fixed;
          top: auto;
          bottom: 0;
          left: 0;
          right: 0;
          z-index: 5;
          height: auto;
          width: 100%;
          flex-direction: row;
          justify-content: space-around;
          padding: 5px 6px max(5px, env(safe-area-inset-bottom));
          gap: 0;
          border-width: 1px 0 0;
        }
        .rail .brand {
          margin: 0;
          font-size: 13px;
        }
        .rail button {
          min-height: 58px;
          width: 60px;
        }
        .rail .rail-bottom {
          display: none;
        }
        .workspace {
          padding: 20px 16px;
        }
        .space-header {
          gap: 12px;
          padding-bottom: 20px;
        }
        .space-header h1 {
          font-size: 24px;
        }
        .columns,
        .bento,
        .engine-grid {
          grid-template-columns: 1fr;
        }
        .connections {
          gap: 7px;
        }
        .connections .card {
          padding: 12px 9px;
          min-height: 170px;
        }
        .connections h3 {
          font-size: 14px;
        }
        .connection-state {
          font-size: 14px;
        }
        .connections p {
          font-size: 12px;
        }
        .gate-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .privacy-card {
          bottom: 16%;
          padding: 16px;
        }
        .toast {
          top: 75px;
        }
        .wake {
          font-size: 12px;
        }
      }
      @media (max-height: 530px) and (min-width: 651px) {
        .face {
          transform: translate(-50%, -40%) scale(0.8);
        }
        .drawer-open .face {
          transform: translate(-50%, -70%) scale(0.55);
        }
        .corners {
          top: 14px;
        }
        .wake {
          bottom: 16px;
        }
        .sheet-backdrop {
          padding: 12px;
        }
        .sheet {
          padding: 16px;
        }
        .sheet-grid {
          grid-template-columns: repeat(6, 1fr);
          margin-top: 10px;
        }
        .sheet-item {
          min-height: 76px;
        }
        .privacy-card {
          bottom: 7%;
          padding: 12px;
        }
        .toast {
          top: 66px;
        }
      }
      /* Presence v3: optical face, recessed hardware and conformal workspaces. */
      .ambient { background-image: radial-gradient(ellipse at 50% 46%, rgba(40,213,255,0.22) 0%, rgba(11,116,255,0.08) 42%, rgba(3,6,12,0) 72%), radial-gradient(rgba(84,167,255,.065) .65px,transparent .9px); background-size: 100% 100%, 7px 7px; }
      #face-stage { position: absolute; inset: 0; }
      .corners .capsule { background: transparent; border-color: transparent; opacity: .42; }
      #openQuick, #openLab { padding: 8px 14px; min-height: 44px; min-width: 44px; font-size: 12px; opacity: .56; }
      #openQuick:hover, #openLab:hover, #openQuick:focus-visible, #openLab:focus-visible { opacity: 1; }
      .face { width: 610px; height: 310px; margin: -155px 0 0 -305px; transform: translateY(0); }
      .eyes { left: 10px; top: 24px; gap: 190px; }
      .orb { width: 200px; height: 200px; border-radius: 50%;
        --eye-tx: 0px; --eye-ty: 0px; --eye-scale: 1; --blink-scale: 1;
        transform: translate(var(--eye-tx), var(--eye-ty)) scale(calc(var(--eye-scale) * var(--blink-scale)));
        background: radial-gradient(circle at 50% 38%, #48E5FF 0%, #24CEFF 68%, #0C7DFF 92%, #0051FF 100%);
        box-shadow: 0 0 68px rgba(40, 213, 255, 0.44), inset 0 -8px 0 0 #0051FF, inset 0 -16px 20px rgba(0, 81, 255, 0.45); }
      .orb::after { content: ""; position: absolute; left: 42px; top: 28px; width: 40px; height: 40px; border-radius: 50%;
        background: radial-gradient(circle, rgba(255,255,255,0.24) 0%, rgba(255,255,255,0) 72%); pointer-events: none; }
      .listening .orb { --eye-ty: -4px; --eye-scale: 1.06; }
      .speaking .orb { --eye-ty: -2px; --eye-scale: 1.03; }
      .curious .orb:first-child { --eye-tx: 4px; --eye-ty: 4px; --eye-scale: 0.86; }
      .curious .orb:nth-child(2) { --eye-tx: -2px; --eye-ty: -6px; --eye-scale: 1.08; }
      .thinking .orb:first-child { --eye-tx: -6px; --eye-ty: -7px; --eye-scale: 0.9; }
      .thinking .orb:nth-child(2) { --eye-tx: -6px; --eye-ty: -10px; --eye-scale: 0.94; }
      .alarmed .orb { --eye-ty: -3px; --eye-scale: 0.95; }
      .aura { inset: -100px -160px; background: radial-gradient(ellipse, rgba(20,105,255,.12), transparent 70%); }
      .aura.inner { display: none; }
      .brow { left: 48px; }
      .neutral .brow, .listening .brow, .face:not(.thinking):not(.curious):not(.alarmed):not(.speaking) .brow { opacity: 0; }
      .mouth { left: calc(50% - 42px); top: 230px; width: 84px; height: 28px; border: 0; color: var(--cyan); overflow: visible; }
      .mouth svg { width: 100%; height: 100%; overflow: visible; }
      .thinking .mouth { width: 60px; height: 16px; left: calc(50% - 30px); transform: rotate(-7deg); }
      .curious .mouth { transform: rotate(-5deg); }
      .alarmed .mouth { transform: rotate(180deg); color: var(--coral); }
      .drawer-open .face, .lab-open .face { transform: translateY(-76px) scale(0.68); }
      .wave-ornament { width: 64px; height: 30px; color: var(--cyan); flex-shrink: 0; filter: drop-shadow(0 0 6px #1275c477); }
      .sheet-backdrop { padding: 0; background: rgba(3,7,13,.1); }
      .sheet { width: min(1040px,100%); max-height: 44vh; overflow: auto; border-radius: 30px 30px 0 0; background: #08111EEB; border-color: rgba(40,213,255,.28); box-shadow: 0 -1px 0 #28d5ff66, 0 -18px 70px #008dff12; padding: 18px 26px 22px; }
      .sheet-grid { grid-template-columns: repeat(4,minmax(0,1fr)); margin-top: 14px; }
      .sheet-item { position: relative; border-radius: 18px; gap: 6px; min-height: 96px; background: linear-gradient(150deg,#12304788,#06111daa); }
      .sheet-item .icon { color: var(--cyan); }
      .sheet-count { font-size: 11px; color: #7edcf3; }
      .sheet-utilities { display: flex; justify-content: flex-end; gap: 14px; margin-top: 12px; }
      .sheet-utilities button { min-height: 44px; padding: 8px 14px; background: transparent; border-color: transparent; font-size: 12px; color: var(--secondary); }
      .sheet-utilities b { color: var(--cyan); font: 10px SFMono-Regular,Consolas,monospace; margin-left: 8px; }
      .sheet.lab-sheet .sheet-grid { grid-template-columns: repeat(6,minmax(0,1fr)); }
      .rail { background: linear-gradient(180deg,#0a1522eb,#040a12f5); }
      .rail .brand { margin: 0 0 16px; min-height: 60px; }
      .brand-mark { width: 56px; height: 52px; filter: drop-shadow(0 0 9px #28d5ff55); }
      .rail .nav-btn { position: relative; background: transparent; border: 1px solid transparent; color: #7D95B2; }
      .rail .nav-btn.active { color: #28D5FF; border-radius: 18px; border: 1.5px solid #28D5FF; background: radial-gradient(circle at 50% 25%, rgba(40,213,255,0.22), rgba(10,24,42,0.88)); box-shadow: 0 0 24px rgba(40,213,255,0.32); }
      .rail .nav-btn.active:after { content: ""; position: absolute; right: -11px; top: calc(50% - 4px); width: 7px; height: 7px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 12px var(--cyan); }
      .header h1 { font-size: 28px; font-weight: 700; display: flex; gap: 16px; align-items: center; }
      .mini { width: 168px; height: 88px; border: 0; border-radius: 40px; background: transparent; box-shadow: none; filter: drop-shadow(0 8px 16px #000b) drop-shadow(0 0 12px #1665ae38); }
      .mini:hover { background: transparent; }
      .mini:before, .mini:after { display: none; }
      .helmet-shell { position: absolute; inset: 4px 7px; border-radius: 42% 42% 38% 38%; background: linear-gradient(180deg, #3A5572 0%, #172638 48%, #09111B 100%); box-shadow: inset 0 1px 2px #9ab9d577, inset 0 -5px 8px #01060a; padding: 17px 10px 9px; }
      .helmet-glass { position: relative; width: 100%; height: 100%; border-radius: 30px; background: #02050A; border: 2px solid #0c1827; box-shadow: 0 0 0 1px #4b698744, inset 0 5px 10px #000; }
      .helmet-ear { position: absolute; width: 10px; height: 41px; top: 27px; border-radius: 50%; background: #122336; border: 1px solid #44658366; }
      .helmet-ear.left { left: 1px; } .helmet-ear.right { right: 1px; }
      .helmet-ear:after { content: ""; position: absolute; inset: 9px 3px; border-radius: 3px; background: #28D5FF; box-shadow: 0 0 9px #28D5FF; }
      .helmet-sensor { position: absolute; top: -2px; left: 50%; transform: translateX(-50%); width: 74px; height: 18px; border-radius: 12px; background: #030b15; border: 1px solid #48617b; box-shadow: 0 2px 5px #000; color: #28D5FF; font: 11px/15px SFMono-Regular,monospace; letter-spacing: 2px; }
      .mini-inner { left: 23px; top: 10px; gap: 34px; }
      .mini-eye { width: 23px; height: 23px; border-radius: 50%; background: linear-gradient(#48e5ff,#19c5ff); box-shadow: 0 0 13px #00aaff66; }
      .mini-mouth { border: 0; width: 18px; height: 9px; left: calc(50% - 9px); bottom: 7px; color: var(--cyan); }
      .memory-timeline { position: relative; padding-left: 22px; }
      .memory-timeline:before { content: ""; position: absolute; left: 4px; top: 20px; bottom: 20px; width: 2px; background: linear-gradient(transparent,#28d5ff88 12%,#126cb588 88%,transparent); }
      .memory-card { position: relative; padding: 0; overflow: visible; }
      .memory-card:before { content: ""; position: absolute; top: 31px; left: -24px; width: 10px; height: 10px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 12px #28d5ffaa; }
      .memory-media { position: relative; aspect-ratio: 16/9; overflow: hidden; border-radius: 19px 19px 0 0; background: #040c15; }
      .memory-media svg { width: 100%; height: 100%; display: block; }
      .media-pill { position: absolute; top: 14px; max-width: calc(100% - 28px); font-size: 10px; padding: 4px 8px; border: 1px solid #45678266; border-radius: 20px; background: #06121ad9; backdrop-filter: blur(10px); }
      .media-pill.time { left: 12px; } .media-pill.trust { right: 12px; color: #a6e8f7; }
      .memory-copy { padding: 18px; } .memory-copy h3 { margin: 0 0 6px; }
      .memory-copy .source-line { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--line); margin-top: 14px; padding-top: 12px; font-size: 12px; color: var(--secondary); }
      .source-line .wave-ornament { width: 28px; height: 20px; }
      #memoryInspector { align-self: start; position: sticky; top: 22px; }
      @keyframes target-pulse { 50% { opacity: .08; transform: scale(1.25); } }
      .target-pulse { transform-origin: center; transform-box: fill-box; animation: target-pulse 3s ease-in-out infinite; }
      .scene { height: auto; aspect-ratio: 2/1; background: radial-gradient(ellipse at 50% 60%,#0d243a,#030b14); }
      .evidence-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin: 18px 0; }
      .evidence-dimension { padding: 14px; border: 1px solid #2a486455; border-radius: 14px; background: #0b1b2a66; min-width: 0; }
      .evidence-dimension dt { color: var(--cyan); font-size: 11px; margin-bottom: 8px; } .evidence-dimension dd { margin: 0; color: var(--secondary); font-size: 13px; }
      .raw-footer { font: 10px/1.7 SFMono-Regular,Consolas,monospace; color: var(--muted); margin-top: 12px; overflow-wrap: anywhere; }
      .approval-shield { border-color: #FFAB2E77; background: linear-gradient(145deg,#33240f55,#101a26 60%); box-shadow: 0 0 28px #ffab2e0d; }
      .approval-shield h2 { color: #FFAB2E; display: flex; align-items: center; gap: 10px; }
      .approval-shield [data-approve] { background: #FFAB2E; color: #1c160a; font-weight: 650; border-color: #ffc879; }
      .command-box { background: #050a10; border: 1px solid #ffab2e66; border-left: 3px solid #FFAB2E; border-radius: 10px; padding: 12px; color: #ffd290 !important; }
      .artifact-pill { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid #28d5ff40; border-radius: 10px; background: #0a2b3b77; font-size: 12px; color: #a7e6ee; margin: 8px 6px 0 0; }
      .cancel-banner { border-radius: 12px; padding: 12px 14px; background: #ffab2e0c; border: 1px solid #ffab2e44; margin: 12px 0; }
      .cancel-banner.safe { border-color: #4ade8055; background: #4ade800a; } .cancel-banner.late { border-color: #fa8e8655; }
      .cancel-banner strong { display: block; margin-bottom: 3px; } .cancel-banner p { font-size: 12px; }
      #homeFeedback { min-height: 20px; margin-top: 8px; }
      .readback-time { display: block; }
      .home-card-header { flex-wrap: nowrap; gap: 8px; }
      .home-card-header .cap-icon { width: 36px; height: 36px; margin-bottom: 0; border-radius: 11px; flex-shrink: 0; }
      .home-card-header h2 { margin: 0; flex: 1; }
      .home-card-header .tag { flex-shrink: 0; }
      .home-on { background: radial-gradient(ellipse at 80% 0,#28d5ff16,transparent 68%),var(--glass); }
      .device-switch { position: relative; width: 52px; height: 30px; min-height: 30px; padding: 0; flex-shrink: 0; border-radius: 20px; background: #152334; border: 1px solid #466178; box-shadow: inset 0 2px 6px #0009; }
      .device-switch::after { content: ""; position: absolute; inset: -8px -4px; }
      .device-switch:disabled { opacity: .4; filter: grayscale(1); cursor: not-allowed; box-shadow: none; }
      .device-switch:before { content: ""; display: block; width: 24px; height: 24px; border-radius: 50%; margin: 2px; background: #8ba0b4; transition: transform .22s,background .22s; }
      .device-switch[aria-checked="true"] { background: linear-gradient(90deg,#0c385d,#117bc6); border-color: #28d5ff; box-shadow: 0 0 15px #28d5ff33; }
      .device-switch[aria-checked="true"]:before { transform: translateX(22px); background: #effbff; box-shadow: 0 0 8px #c9f3ff99; }
      .brightness-track { -webkit-appearance: none; appearance: none; height: 44px; min-height: 44px; margin: 4px 0; padding: 0; cursor: pointer; border: 0; border-radius: 6px; background: linear-gradient(90deg,#1382dd,#28d5ff) 0 center / var(--level,50%) 8px no-repeat, linear-gradient(#1b2b3e,#1b2b3e) 0 center / 100% 8px no-repeat; box-shadow: none; }
      .brightness-track::-webkit-slider-thumb { -webkit-appearance: none; box-sizing: border-box; width: 24px; height: 24px; border: 3px solid #e1faff; border-radius: 50%; background: #28d5ff; box-shadow: 0 0 12px #28d5ff99; }
      .brightness-track::-moz-range-thumb { box-sizing: border-box; width: 24px; height: 24px; border: 3px solid #e1faff; border-radius: 50%; background: #28d5ff; }
      .pill-btn { padding: 8px 14px; min-height: 44px; border-radius: 20px; font-size: 12px; color: var(--secondary); }
      .pill-btn.selected { color: #dffaff; border-color: #28D5FF; background: #12354b; box-shadow: 0 0 14px #28d5ff30,inset 0 0 12px #28d5ff12; }
      .temperature-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; box-shadow: 0 0 8px currentColor; background: currentColor; }
      .sensor-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 18px; margin-top: 18px; }
      .sensor-value { font-size: clamp(22px,2.3vw,32px); white-space: nowrap; }
      .meter { height: 5px; border-radius: 5px; background: #1b2b3d; overflow: hidden; margin: 12px 0 8px; }
      .meter > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg,#146cb2,#28d5ff); box-shadow: 0 0 10px #28d5ff66; }
      .dual-grid { display: grid; grid-template-columns: minmax(0,1.35fr) minmax(0,1fr); gap: 20px; margin-bottom: 20px; }
      .brain-divider { margin: 20px 0; border-top: 1px solid var(--line); }
      .health-row { display: flex; align-items: center; gap: 20px; margin-top: 16px; }
      .drift-radar { width: 120px; height: 120px; flex-shrink: 0; }
      .gate { border: 1px solid var(--line); padding: 16px; border-radius: 16px; background: #0a192966; }
      .gate .icon { color: #28d5ff; margin-bottom: 8px; } .gate strong { font-size: 16px; margin-top: 10px; }
      .gate small { display: block; font-size: 10px; margin-top: 8px; }
      .gate-report-row { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; padding-top: 16px; border-top: 1px solid var(--line); }
      .gate-report-row > div { padding: 0 6px; } .gate-report-row strong { display: block; font: 26px/1.5 SFMono-Regular,Consolas,monospace; }
      .acceptance-group .row { margin: 0; } .acceptance-group strong { color: #a0eaf8; font: 16px SFMono-Regular,Consolas,monospace; }
      .report-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .report-toggle { color: var(--cyan); background: transparent; }
      .acceptance-group { text-align: left; }
      .acceptance-group[aria-pressed="true"] { border-color: var(--cyan); background: #12354b; }
      .mobile-tabs, .mobile-back { display: none; }
      .mobile-tabs button[aria-pressed="true"] { color: var(--cyan); border-color: var(--cyan); background: #12354b; }
      .sheet { transition: transform .2s ease-out; overscroll-behavior: contain; }
      .sheet-header, .sheet .handle { touch-action: pan-x; }
      #memoryInspector .memory-actions { gap: 12px; }
      @media (min-width: 480px) { #memoryInspector [data-memory="forget"] { margin-left: auto; } }
      .report-case { padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
      @media (max-width: 900px) { .sheet { padding: 16px 20px; } .sheet-utilities { margin-top: 8px; } .sheet-item { min-height: 80px; } }
      @media (max-width: 720px) {
        .shell { display: block; padding-bottom: calc(82px + env(safe-area-inset-bottom)); }
        .rail { position: fixed; top: auto; bottom: 0; left: 0; right: 0; z-index: 6; width: 100%; height: auto; display: flex; flex-direction: row; justify-content: space-around; gap: 4px; padding: 6px 8px calc(6px + env(safe-area-inset-bottom)); border-width: 1px 0 0; }
        .rail .brand { margin: 0; min-height: 52px; width: 52px; } .brand-mark { width: 44px; height: 42px; }
        .rail .nav-btn { width: 60px; min-height: 54px; min-width: 58px; } .rail .nav-btn.active:after { top: -5px; bottom: auto; left: calc(50% - 3.5px); right: auto; }
        .rail .rail-bottom { display: none; }
        .workspace { padding: 22px 16px; } .header { gap: 12px; } .header h1 { font-size: 23px; gap: 8px; } .header h1 .wave-ornament { width: 40px; }
        .mini { width: 168px; height: 88px; transform: scale(0.72); transform-origin: right center; margin: -12px 0 -12px -40px; }
        .columns, .connections, .home-grid, .dual-grid, .evidence-grid, .bento, .engine-grid { grid-template-columns: 1fr; }
        .connections { gap: 12px; } .connections .card { padding: 12px 14px; min-height: 0; } .connections h3 { font-size: 17px; }
        .connections .cap-icon { width: 32px; height: 32px; margin-bottom: 6px; }
        .connection-state { margin: 6px 0; font-size: 15px; } #memoryInspector { position: static; }
        #memoryInspector .scene { aspect-ratio: 16 / 7.5; margin: 8px 0 10px; }
        #memoryInspector .evidence-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 8px 0 10px; }
        #memoryInspector .evidence-dimension { padding: 8px 10px; }
        #memoryInspector .evidence-dimension:last-child { grid-column: 1 / -1; }
        .filters input { flex: 1 1 100%; width: 100%; }
        .perception { max-width: calc(100% - 148px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; padding: 8px 10px; }
        .face { transform: scale(.57); } .drawer-open .face, .lab-open .face { transform: translateY(-76px) scale(.46); }
        .wake { gap: 9px; font-size: 11px; letter-spacing: 0; bottom: 22px; } .wake .wave-ornament { width: 32px; } .wake .parenthesis { font-size: 22px; }
        .sheet { padding: 14px; } .sheet-grid { gap: 7px; } .sheet-item { padding: 8px 3px; font-size: 11px; min-height: 76px; } .sheet-count { font-size: 9px; }
        .sheet.lab-sheet .sheet-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }
        .sheet-utilities { justify-content: space-between; } .sheet-utilities button { font-size: 11px; min-height: 44px; padding: 8px 10px; }
        .mobile-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; position: sticky; top: 0; z-index: 3; padding: 8px 0; background: var(--deep); }
        .mobile-tabs button { min-height: 44px; padding: 8px; }
        .mobile-back { display: inline-flex; margin-bottom: 12px; }
        #memoriesSpace[data-pane="list"] #memoryInspector,
        #memoriesSpace[data-pane="inspector"] #memoryList,
        #memoriesSpace[data-pane="inspector"] .filters,
        #tasksSpace[data-pane="tasks"] .task-decisions,
        #tasksSpace[data-pane="decisions"] .task-artifacts { display: none; }
        .gate-report-row { grid-template-columns: repeat(2,minmax(0,1fr)); }
        .sensor-grid { gap: 12px; } .sensor-grid .raw-footer { font-size: 9px; } .sensor-value { font-size: 24px; }
      }
      @media (max-width: 380px) { .header h1 { font-size: 20px; } .header h1 .wave-ornament { display: none; } .mini { width: 168px; height: 88px; transform: scale(0.64); transform-origin: right center; margin: -16px 0 -16px -54px; } .sensor-grid { grid-template-columns: 1fr; } }
      @media (max-height: 530px) and (min-width: 721px) {
        .rail { padding: 6px 6px; gap: 4px; overflow-y: auto; }
        .rail button, .rail .nav-btn, .rail .rail-bottom { min-height: 48px; width: 70px; padding: 3px 2px; gap: 2px; font-size: 11px; }
        .rail .brand { min-height: 44px; width: 64px; padding: 2px; margin: 0 0 2px; }
        .brand-mark { width: 38px; height: 34px; }
        .rail button .icon { width: 18px; height: 18px; }
        .face { transform: scale(.78); } .drawer-open .face, .lab-open .face { transform: translateY(-76px) scale(.53); } .wake { bottom: 10px; }
        .sheet { max-height: min(82dvh, 332px); padding: 10px 20px 12px; }
        .sheet .handle { margin: -4px auto 8px; width: 44px; height: 4px; }
        .sheet-grid { margin-top: 8px; gap: 8px; }
        .sheet-item { min-height: 68px; padding: 6px 8px; gap: 4px; }
        .sheet-item .icon { height: 20px; } .sheet-utilities { margin-top: 6px; }
      }
      @media (max-height: 500px) and (min-width: 721px) {
        .workspace { padding: 8px 16px 10px; }
        .space-header { padding-bottom: 6px; gap: 12px; min-height: 48px; height: 52px; }
        .space-header p { display: none; }
        .header h1 { font-size: 22px; }
        .mini { width: 168px; height: 88px; transform: scale(0.62); transform-origin: right center; margin: -18px 0 -18px -48px; }
        .card { padding: 14px 16px; }
        .filters { margin-bottom: 8px; gap: 6px; }
        .memory-media { aspect-ratio: auto; height: 84px; }
        .memory-copy { padding: 10px 12px; }
        .memory-copy .source-line { margin-top: 8px; padding-top: 8px; }
        .memory-copy .raw-footer { display: none; }
        #memoriesSpace { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); column-gap: 22px; align-items: start; }
        #memoriesSpace > .columns { display: contents; }
        #memoriesSpace .filters { grid-column: 1; grid-row: 1; }
        #memoriesSpace .filters input { flex: 1 1 100%; }
        #memoryList { grid-column: 1; grid-row: 2; }
        #memoryList .memory-card { padding: 0; }
        #memoryInspector { grid-column: 2; grid-row: 1 / span 2; padding: 12px 14px; }
        #memoryInspector h2 { font-size: 16px; line-height: 1.3; margin-bottom: 0; }
        #memoryInspector .scene { display: block; aspect-ratio: auto; height: 88px; margin: 6px 0 8px; }
        #memoryInspector h3 { font-size: 15px; line-height: 1.3; margin-bottom: 4px; }
        #memoryInspector .evidence-grid { gap: 6px; margin: 6px 0 8px; }
        #memoryInspector .evidence-dimension { padding: 6px 8px; }
        #memoryInspector .evidence-dimension dt { margin-bottom: 2px; font-size: 10px; line-height: 1.2; }
        #memoryInspector .evidence-dimension dd { font-size: 11px; line-height: 1.35; }
        #memoryInspector .card .row, #memoryInspector > .row { margin-top: 6px; }
        #tasksSpace .approval-shield { padding: 12px 14px; }
        #tasksSpace .approval-shield h2 { font-size: 16px; margin-bottom: 4px; }
        #tasksSpace .approval-shield h3 { font-size: 14px; margin-top: 6px !important; margin-bottom: 4px; }
        #tasksSpace .approval-shield .evidence-grid { margin: 6px 0; gap: 6px; }
        #tasksSpace .approval-shield .evidence-dimension { padding: 6px 8px; }
        #tasksSpace .approval-shield .evidence-dimension small { display: none; }
        #tasksSpace .command-box { padding: 6px 10px; margin: 4px 0; }
        #tasksSpace .approval-shield .row { margin-top: 8px; }
        #homeSpace > .row.spread { margin-bottom: 6px !important; }
        .bento { gap: 10px; }
        .bento .card { min-height: 0; padding: 10px 14px; }
        .bento .card > p { font-size: 12px; margin-top: 2px; }
        .bento .home-card-header h2 { font-size: 15px; margin: 0; }
        .bento .home-card-header .tag { font-size: 10px; padding: 3px 6px; }
        .bento .card > label { margin-top: 4px !important; }
        .bento .pill-btn { min-width: 44px; font-size: 11px; padding: 8px 6px; }
        .brightness-track { display: block; margin: 2px 0; }
        .brightness-scale { display: none; }
        .options { margin-top: 6px; gap: 6px; }
        .bento .raw-footer { margin-top: 6px; font-size: 9px; line-height: 1.4; }
        .bento .readback-time { display: inline; }
        .bento .readback-time:before { content: " · "; }
      }
      /* Zero-Scroll Bento Cockpit v4.1 (Phase 10 Craft) */
      .rail { background: linear-gradient(180deg, rgba(12, 23, 36, 0.95) 0%, rgba(5, 11, 19, 0.98) 100%); border-right: 1px solid rgba(155, 215, 255, 0.16); }
      .rail .brand { border-radius: 18px; border: 1px solid rgba(40, 213, 255, 0.34); background: linear-gradient(160deg, rgba(28, 76, 114, 0.32) 0%, rgba(8, 18, 30, 0.92) 100%); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(164, 224, 255, 0.22); }
      .rail .nav-btn { border-radius: 16px; border: 1px solid rgba(155, 215, 255, 0.12); background: rgba(12, 24, 38, 0.45); transition: all 0.18s ease; }
      .rail .nav-btn.active { border-color: rgba(40, 213, 255, 0.88); background: linear-gradient(160deg, rgba(40, 213, 255, 0.24) 0%, rgba(16, 45, 74, 0.72) 52%, rgba(8, 20, 34, 0.92) 100%); box-shadow: 0 0 18px rgba(40, 213, 255, 0.28), inset 0 1px 0 rgba(190, 242, 255, 0.28); }
      .workspace { padding: 14px clamp(14px, 2.2vw, 28px) 14px; background: radial-gradient(ellipse at 50% 0%, rgba(28, 100, 160, 0.12) 0%, rgba(7, 17, 29, 0) 68%); }
      .space-header { padding-bottom: 10px; min-height: 0; }
      .space-header p, .footer { display: none; }
      .card.glass { border: 1px solid rgba(155, 215, 255, 0.16); background: linear-gradient(165deg, rgba(24, 38, 56, 0.92) 0%, rgba(10, 17, 27, 0.94) 100%); border-radius: 16px; padding: 14px 16px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22); }
      .memory-media { display: none; }
      .memory-copy { padding: 12px 14px; }
      .memory-copy .source-line { margin-top: 8px; padding-top: 8px; }
      .bento { gap: 12px; }
      .bento .card { min-height: 0; }
      .connections { gap: 10px; margin-bottom: 12px; }
      .connections .card { min-height: 0; padding: 12px 14px; }
      .connection-state { margin: 6px 0; font-size: 15px; }
      .dual-grid { gap: 12px; margin-bottom: 12px; align-items: stretch; }
      @media (prefers-reduced-motion: reduce) {
        *,
        *:before,
        *:after {
          animation: none !important;
          transition: none !important;
        }
        .waves i {
          height: 18px;
        }
      }
    </style>
  </head>
  <body>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      style="position: absolute; width: 0; height: 0"
      aria-hidden="true"
    >
      <defs>
        <symbol id="i-book" viewBox="0 0 24 24">
          <path d="M12 5c-3-2-7-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1v15" />
        </symbol>
        <symbol id="i-task" viewBox="0 0 24 24">
          <rect x="5" y="4" width="14" height="17" rx="3" />
          <path d="M9 4V2h6v2M9 10l1 1 2-3m2 2h2m-7 6 1 1 2-3m2 2h2" />
        </symbol>
        <symbol id="i-home" viewBox="0 0 24 24">
          <path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7" />
        </symbol>
        <symbol id="i-tool" viewBox="0 0 24 24">
          <path d="M14 5a6 6 0 0 0-7 8L3 17a2.8 2.8 0 0 0 4 4l4-4a6 6 0 0 0 8-7l-4 4-4-4 4-4Z" />
        </symbol>
        <symbol id="i-lock" viewBox="0 0 24 24">
          <rect x="5" y="10" width="14" height="11" rx="3" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
        </symbol>
        <symbol id="i-lab" viewBox="0 0 24 24">
          <path d="M9 3h6m-5 0v7L4 19a1.5 1.5 0 0 0 1 2h14a1.5 1.5 0 0 0 1-2l-6-9V3M7 15h10" />
        </symbol>
        <symbol id="i-grid" viewBox="0 0 24 24">
          <rect x="3" y="3" width="7" height="7" rx="2" />
          <rect x="14" y="3" width="7" height="7" rx="2" />
          <rect x="3" y="14" width="7" height="7" rx="2" />
          <rect x="14" y="14" width="7" height="7" rx="2" />
        </symbol>
        <symbol id="i-mic" viewBox="0 0 24 24">
          <rect x="9" y="2" width="6" height="13" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8" />
        </symbol>
        <symbol id="i-camera" viewBox="0 0 24 24">
          <path d="M3 7h4l2-3h6l2 3h4v14H3Z" />
          <circle cx="12" cy="13" r="4" />
        </symbol>
        <symbol id="i-eye" viewBox="0 0 24 24">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" />
          <circle cx="12" cy="12" r="3" />
        </symbol>
        <symbol id="i-dock" viewBox="0 0 24 24">
          <rect x="7" y="2" width="10" height="16" rx="3" />
          <path d="M3 17v5h18v-5m-10-2h2" />
        </symbol>
        <symbol id="i-stop" viewBox="0 0 24 24">
          <path d="m8 2-6 6v8l6 6h8l6-6V8l-6-6Z" />
          <path d="M12 7v6m0 3v1" />
        </symbol>
        <symbol id="i-shield" viewBox="0 0 24 24"><path d="m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5Z"/><path d="m8 11 3 3 5-6"/></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></symbol>
        <symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6" /></symbol>
        <symbol id="i-light" viewBox="0 0 24 24">
          <path
            d="M9 18h6m-5 3h4m-6-7a6 6 0 1 1 8 0l-1 2H9Zm4-13v1M2 8h2m16 0h2M4 2l2 2m12 0 2-2"
          />
        </symbol>
        <symbol id="i-fan" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="2" />
          <path
            d="M12 10C6 3 14 0 16 5c1 2-1 4-3 5m1 2c9-2 8 6 3 7-2 0-4-2-4-5m-3-1c-3 8-9 2-6-2 1-2 4-2 6 0"
          />
        </symbol>
        <symbol id="i-sensor" viewBox="0 0 24 24">
          <path d="M10 14V5a2 2 0 0 1 4 0v9a5 5 0 1 1-4 0m2-6v10m6-12h3m-3 4h2" />
        </symbol>
        <symbol id="i-link" viewBox="0 0 24 24">
          <path
            d="m9 15 6-6m-6 9-2 2a5 5 0 0 1-7-7l5-5a5 5 0 0 1 7 0m0-2 2-2a5 5 0 0 1 7 7l-5 5a5 5 0 0 1-7 0"
            transform="translate(1 0) scale(.9)"
          />
        </symbol>
      </defs>
    </svg>
    <main>
      <section id="ambient" class="ambient screen" aria-label="LOOI 全屏陪伴">
        <div id="face-stage"><button id="faceHit" class="face-hit" aria-label="轻触 LOOI 唤出功能"></button></div>
        <div class="corners">
          <button class="capsule perception" data-space="cabin">
            <span class="dot"></span><span id="perceptionText">感知未接入 · 连接 Hub 中</span>
          </button>
          <div class="row">
            <button id="liveVoiceBtn" class="capsule" aria-label="开启实时全双工对话"><svg class="icon"><use href="#i-mic" /></svg><span id="liveVoiceLabel">LIVE 对话</span></button
            ><button id="stopAgentBtn" class="capsule" hidden>停止任务</button
            ><button id="openAskBtn" class="capsule" aria-label="向 Personal Agent 发送指令">对话</button
            ><button id="openQuick" class="capsule" aria-label="打开快捷功能抽屉"><span id="open-drawer"><svg class="icon"><use href="#i-grid" /></svg>功能</span></button
            ><button id="openLab" class="capsule" aria-label="打开仿真演练台"><span id="open-lab"><svg class="icon"><use href="#i-lab" /></svg>仿真台</span>
            </button>
          </div>
        </div>
        <form id="askBar" class="ask-bar glass" hidden>
          <input id="askInput" type="text" placeholder="直接对 LOOI 说（如：记住我钥匙在抽屉 / 查看当前目录）" aria-label="向 LOOI 发送指令" />
          <button type="submit">发送</button>
        </form>
        <div id="face" class="face" aria-hidden="true">
          <div class="aura"></div>
          <div class="aura inner"></div>
          <div class="eyes">
            <div class="orb"><span class="brow"></span></div>
            <div class="orb"><span class="brow"></span></div>
          </div>
          <div class="mouth"><svg viewBox="0 0 84 28"><path d="M10 8 Q42 30 74 8" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg></div>
          <div class="waves">
            <i style="--i: 1"></i><i style="--i: 3"></i><i style="--i: 5"></i><i style="--i: 6"></i
            ><i style="--i: 5"></i><i style="--i: 3"></i><i style="--i: 1"></i>
          </div>
        </div>
        <div id="privacyCard" class="privacy-card glass" hidden>
          <svg class="icon"><use href="#i-lock" /></svg>
          <h2>此浏览器已暂停交互</h2>
          <p>浏览器未采集相机与麦克风。设备端隐私状态未接入；此开关不代表远端硬件已断开。</p>
          <p>轻触大脸恢复</p>
        </div>
        <div id="subtitle" class="subtitle glass" hidden></div>
        <button id="motionStop" class="motion-stop" hidden>
          <svg class="icon"><use href="#i-stop" /></svg>停止本地演练
        </button>
        <button id="wakeBar" hidden class="wake" aria-label="轻触屏幕展开快捷功能"><svg class="wave-ornament" viewBox="0 0 64 32" aria-hidden="true"><g stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path opacity=".25" d="M5 15v2M59 15v2"/><path opacity=".45" d="M14 13v6M50 13v6"/><path opacity=".7" d="M23 9v14M41 9v14"/><path d="M32 3v26"/></g></svg><span><span class="parenthesis">(</span> 说 <span class="hey">Hey LOOI</span> 唤醒我 · 轻触屏幕展开 <span class="parenthesis">)</span></span><svg class="wave-ornament" viewBox="0 0 64 32" aria-hidden="true"><g stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path opacity=".25" d="M5 15v2M59 15v2"/><path opacity=".45" d="M14 13v6M50 13v6"/><path opacity=".7" d="M23 9v14M41 9v14"/><path d="M32 3v26"/></g></svg></button>
      </section>
      <section id="shell" class="shell screen" hidden>
        <nav class="rail glass" aria-label="共形空间">
          <button class="brand" data-space="face" aria-label="返回 LOOI 大脸"><svg class="brand-mark" viewBox="0 0 64 56" aria-hidden="true"><path d="M7 39 13 8 26 21h12L51 8l6 31-8 11H15Z" fill="#092035" stroke="#28D5FF" stroke-width="4" stroke-linejoin="round"/><path d="M12 36q0-12 20-12t20 12l-6 9H18Z" fill="#02050A"/><ellipse cx="24" cy="33" rx="4" ry="5" fill="#28D5FF"/><ellipse cx="40" cy="33" rx="4" ry="5" fill="#28D5FF"/></svg></button
          ><button class="nav-btn" data-space="memories">
            <svg class="icon"><use href="#i-book" /></svg>回忆册</button
          ><button class="nav-btn" data-space="tasks">
            <svg class="icon"><use href="#i-task" /></svg>约定任务</button
          ><button class="nav-btn" data-space="home">
            <svg class="icon"><use href="#i-home" /></svg>书房家居</button
          ><button class="nav-btn" data-space="cabin">
            <svg class="icon"><use href="#i-tool" /></svg>维修舱</button
          ><button class="rail-bottom" data-open="lab">
            <svg class="icon"><use href="#i-lab" /></svg>仿真台
          </button>
        </nav>
        <div class="workspace">
          <header class="space-header header">
            <div>
              <h1 id="spaceTitle">回忆册</h1>
              <p id="spaceSub">每一条记忆，都保留它的来处。</p>
            </div>
            <button id="mini" class="mini" data-space="face" aria-label="迷你 LOOI，返回大脸">
              <span class="helmet-ear left"></span><span class="helmet-ear right"></span><span class="helmet-shell"><span class="helmet-sensor">··· M ···</span><span class="helmet-glass" style="display:block"><span class="mini-inner"><i class="mini-eye"></i><i class="mini-eye"></i></span><svg class="mini-mouth" viewBox="0 0 24 12"><path d="M3 3Q12 13 21 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span></span>
            </button>
          </header>
          <div id="cutoff" class="cutoff glass" hidden></div>
          <div id="spaceError" class="error-banner" role="status" hidden></div>
          <section id="memoriesSpace" data-pane="list" hidden>
            <div id="memoryTabs" class="mobile-tabs" role="group" aria-label="记忆视图">
              <button data-memory-pane="list" aria-pressed="true" aria-controls="memoryList">记忆时间轴</button>
              <button data-memory-pane="inspector" aria-pressed="false" aria-controls="memoryInspector">证据检视器</button>
            </div>
            <div class="filters">
              <input
                id="memorySearch"
                type="search"
                aria-label="搜索记忆"
                placeholder="搜索物品、位置或内容"
              /><button data-filter="all" aria-pressed="true">全部</button
              ><button data-filter="confirmed" aria-pressed="false">已确认</button
              ><button data-filter="observed" aria-pressed="false">观察</button
              ><button data-filter="inferred" aria-pressed="false">推测</button>
            </div>
            <div class="columns">
              <div id="memoryList" class="stack memory-timeline"></div>
              <aside id="memoryInspector" class="card glass" tabindex="-1"></aside>
            </div>
          </section>
          <section id="tasksSpace" data-pane="tasks" hidden>
            <div id="taskTabs" class="mobile-tabs" role="group" aria-label="任务视图">
              <button data-task-pane="tasks" aria-pressed="true" aria-controls="taskList">任务与产物</button>
              <button data-task-pane="decisions" aria-pressed="false" aria-controls="approvalPanel rulesList">审批与约定 <span id="pendingApprovalBadge" class="tag amber" hidden></span></button>
            </div>
            <div class="columns">
              <div class="task-artifacts">
                <div class="row spread" style="margin-bottom: 16px">
                  <h2>任务流</h2>
                  <span class="caption">按 Hub 事件回读</span>
                </div>
                <div id="taskList" class="stack"></div>
              </div>
              <div class="stack task-decisions">
                <section id="approvalPanel" class="card glass approval-shield"></section>
                <section class="card glass">
                  <h2>日常约定</h2>
                  <p class="caption">从已确认的家居规则读取；提案需单独确认。</p>
                  <div id="rulesList"></div>
                </section>
              </div>
            </div>
          </section>
          <section id="homeSpace" hidden>
            <div class="row spread" style="margin-bottom: 18px">
              <p id="homeSource">正在读取设备能力与状态</p>
              <button id="refreshHome">刷新回读</button>
            </div>
            <input id="homeSearch" type="search" placeholder="搜索设备或房间" aria-label="搜索家居设备" style="width:100%;min-height:44px;margin-bottom:12px" />
            <div id="homeGrid" class="bento home-grid"></div>
            <button id="homeMore" hidden style="min-height:44px;margin-top:12px">继续显示</button>
            <section class="card glass" style="margin-top: 20px">
              <div class="row spread">
                <div>
                  <h2>偏好与边界</h2>
                  <p>每次微调记录到 Hub；连续三次生成待确认提案。</p>
                </div>
                <button id="resolveHome">“书房灯”目标消歧</button>
              </div>
              <div id="homeFeedback" class="caption" role="status"></div>
              <div id="homeProposals"></div>
            </section>
          </section>
          <section id="cabinSpace" hidden>
            <div id="connections" class="connections"></div>
            <div class="dual-grid"><section class="card glass"><h2>双脑路由</h2><p class="caption">声音与视觉，各自选择最适合的引擎。</p><div class="brain-divider"></div><h3>语音双轨</h3><p id="voiceStatus">读取中</p><div id="voiceOptions" class="options"></div><div class="brain-divider"></div><h3>视觉引擎</h3><p id="visionStatus">读取中</p><div id="visionOptions" class="options"></div></section><section id="hardwareHealth" class="card glass"></section></div>
            <section class="card glass">
              <div class="row spread">
                <div>
                  <h2>48 项核心验收</h2>
                  <p id="reportSummary">尚未运行 · A–H 八组 / 四大硬门禁</p>
                </div>
                <div class="report-actions">
                  <button id="runAcceptance"><svg class="icon"><use href="#i-lab" /></svg>运行 48 项验收</button>
                  <button id="toggleReport" class="report-toggle" aria-expanded="false" aria-controls="reportDetails">展开 48 项用例明细</button>
                </div>
              </div>
              <p class="caption" style="margin-top: 12px">
                Hub 内置软件验收报告，含仿真与模型化检查；不代表真实硬件或移动端逐屏验收。
              </p>
              <div id="gateGrid" class="gate-grid"></div>
              <div id="acceptanceGrid" class="acceptance-grid"></div>
              <div id="reportDetails" hidden></div>
            </section>
          </section>
          <footer class="footer">
            <span id="ledgerStatus">等待 Hub 回读</span><span>Presence v3.0 · 每 5 秒同步</span>
          </footer>
        </div>
      </section>
    </main>
    <div id="toast" class="toast glass" role="status" aria-live="polite" hidden></div>
    <div id="sheetBackdrop" class="sheet-backdrop" hidden>
      <section
        id="sheet"
        class="sheet glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheetTitle"
      >
        <div class="handle"></div>
        <div class="row spread sheet-header">
          <div>
            <h2 id="sheetTitle">一起做点什么</h2>
            <p id="sheetSub" class="caption">7.5 秒无操作后回到陪伴 · 支持下滑收起</p>
          </div>
          <button id="closeSheet" class="close" aria-label="关闭抽屉">
            <svg class="icon"><use href="#i-close" /></svg>
          </button>
        </div>
        <div id="sheetItems" class="sheet-grid"></div><div id="sheetUtilities" class="sheet-utilities"></div>
      </section>
    </div>
    <script>
      "use strict";
      const $ = (id) => document.getElementById(id);
      const clean = (value) =>
        String(value == null ? "" : value).replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");
      const esc = (value) =>
        clean(value).replace(
          /[&<>"']/g,
          (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
        );
      const icon = (name) =>
        '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
      const date = (value) =>
        value && Number.isFinite(Date.parse(value))
          ? new Date(value).toLocaleString("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            })
          : "尚无时间回报";
      const wakeGuideKey = "super-looi.wake-guide-dismissed.v1";
      function hasDismissedWakeGuide() {
        try { return localStorage.getItem(wakeGuideKey) === "1"; }
        catch { return true; }
      }
      const state = {
        wakeGuideDismissed: hasDismissedWakeGuide(),
        space: "face",
        sheet: null,
        privacy: false,
        speaking: false,
        docked: true,
        cutoff: null,
        expression: "neutral",
        claims: [],
        selected: null,
        mobileMemoryPane: "list",
        mobileTaskPane: "tasks",
        autoFocusedApproval: false,
        filter: "all",
        tasks: [],
        taskEvents: {},
        grants: {},
        rules: [],
        proposals: [],
        entities: [],
        snapshots: [],
        homeMode: "unknown",
        status: null,
        voice: null,
        vision: null,
        report: null,
        reportExpanded: false,
        reportGroup: null,
        running: false,
        errors: {},
        cancels: {},
        motion: false,
        motionGeneration: 0,
        lastRead: null,
      };
      let drawerTimer,
        toastTimer,
        expressionTimer,
        speechTimer,
        blinkTimer,
        returnFocus,
        refreshBusy = false;
      let touchY = null;
      let sheetDrag = null;
      let suppressSheetClickUntil = 0;
      let refreshTimer, blinkInterval;
      const sessionId = "web_" + Date.now();
      function userAction() {
        const now = Date.now();
        return {
          event_id: "tap_" + now,
          ui_session_id: sessionId,
          kind: "tap",
          captured_at: new Date(now).toISOString(),
          expires_at: new Date(now + 60000).toISOString(),
        };
      }
      async function api(path, body, timeout = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(path, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
          return data;
        } finally {
          clearTimeout(timer);
        }
      }
      function toast(message, tone = "") {
        clearTimeout(toastTimer);
        $("toast").textContent = clean(message);
        $("toast").className = "toast glass " + tone;
        $("toast").hidden = false;
        toastTimer = setTimeout(() => ($("toast").hidden = true), 3000);
      }
      function expression(kind, duration = 0) {
        clearTimeout(expressionTimer);
        state.expression = kind;
        renderFace();
        if (duration)
          expressionTimer = setTimeout(() => {
            state.expression = "neutral";
            renderFace();
          }, duration);
      }
      function renderFace() {
        $("wakeBar").hidden = state.wakeGuideDismissed || state.privacy || state.motion || state.speaking;
        $("face").className =
          "face " + (state.privacy ? "sleeping" : state.speaking ? "speaking" : state.expression);
        $("privacyCard").hidden = !state.privacy;
        $("motionStop").hidden = !state.motion;
        $("subtitle").hidden = !state.speaking;
        $("subtitle").textContent = "说话动画演练 · 未采集音频";
        $("perceptionText").textContent = state.privacy
          ? "本页暂停 · 设备状态未接入"
          : state.errors.status
            ? "Hub 不可达 · 感知未接入"
            : "Web 陪伴 · 感知未接入";
        $("cutoff").hidden = !state.cutoff;
        $("cutoff").textContent =
          "脱座演练 · 本页观察截止于 " + date(state.cutoff) + "；不代表硬件底座状态";
      }
      function closeSheet(restore = true) {
        clearTimeout(drawerTimer);
        state.sheet = null;
        resetSheetDrag();
        $("sheetBackdrop").hidden = true;
        $("ambient").classList.remove("drawer-open", "lab-open");
        $("ambient").inert = false;
        $("shell").inert = false;
        if (restore && returnFocus && returnFocus.isConnected) returnFocus.focus();
      }
      function armDrawer() {
        clearTimeout(drawerTimer);
        if (state.sheet !== "quick") return;
        drawerTimer = setTimeout(() => closeSheet(), 7500);
      }
      function openSheet(kind) {
        if (state.privacy) {
          toast("轻触大脸恢复本页交互");
          return;
        }
        if (!state.sheet) returnFocus = document.activeElement;
        if (kind === "quick") {
          state.wakeGuideDismissed = true;
          $("wakeBar").hidden = true;
          // A removed guide cannot be the focus target when the drawer closes.
          if (returnFocus === $("wakeBar")) returnFocus = $("faceHit");
          try { localStorage.setItem(wakeGuideKey, "1"); } catch { /* Keep it hidden this session. */ }
        }
        resetSheetDrag();
        state.sheet = kind;
        $("sheetBackdrop").hidden = false;
        $("ambient").classList.remove("drawer-open", "lab-open");
        $("ambient").classList.add(kind === "lab" ? "lab-open" : "drawer-open");
        $("sheet").className = "sheet glass" + (kind === "lab" ? " lab-sheet" : "");
        $("ambient").inert = true;
        $("shell").inert = true;
        $("sheetTitle").textContent = kind === "lab" ? "仿真演练台" : "一起做点什么";
        $("sheetSub").textContent =
          kind === "lab" ? "动作先收起抽屉 · 设备感知与急停仅为本页演练" : "7.5 秒无操作后回到陪伴 · 支持下滑收起";
        const items =
          kind === "lab"
            ? [
                ["speak", "mic", state.speaking ? "结束说话测试" : "说话测试"],
                ["snapshot", "camera", "记当前画面"],
                ["look", "eye", "主动微观察"],
                ["dock", "dock", state.docked ? "拔下手机" : "放回底座"],
                ["stop", "stop", "紧急急停"],
                ["acceptance", "lab", "运行 48 项验收"],
              ]
            : [
                ["memories", "book", "记忆与证据"],
                ["tasks", "task", "委托与自动化"],
                ["home", "home", "智能家居控制"],
                ["cabin", "tool", "设备舱与体检"],
              ];
        $("sheetItems").innerHTML = items
          .map(
            (item) =>
              '<button class="sheet-item ' +
              (item[0] === "stop" ? "danger" : "") +
              '" data-' +
              (kind === "lab" ? "sim" : "quick") +
              '="' +
              item[0] +
              '">' +
              icon(item[1]) +
              "<span>" +
              item[2] +
              "</span>" + (kind === "quick" ? '<span class="sheet-count" data-quick-count="' + item[0] + '">' + esc(quickCount(item[0])) + "</span>" : "") + "</button>",
          )
          .join("");
        $("sheetUtilities").innerHTML = kind === "quick" ? '<button data-quick="privacy">' + icon("lock") + ' 隐私开关 · ' + (state.privacy ? "本页已暂停" : "本页交互中") + '</button><button data-quick="lab">' + icon("lab") + ' 仿真实验台 <b>LAB</b></button>' : '<span class="caption">仅本页仿真，硬件状态独立核实</span>';
        $("closeSheet").focus();
        if (kind === "lab") clearTimeout(drawerTimer);
        else armDrawer();
      }
      const titles = {
        memories: ["记忆与证据", "每一条记忆，都保留它的来处。"],
        tasks: ["委托与自动化", "让进展有凭据，让取消有回音。"],
        home: ["智能家居控制", "给身边的设备，一个明确的回应。"],
        cabin: ["设备舱与体检", "各自报告，各自核实。"],
      };
      function switchSpace(space) {
        const changed = state.space !== space;
        if (changed && $("correctionForm")) $("correctionForm").hidden = true;
        closeSheet(false);
        state.space = space;
        $("ambient").hidden = space !== "face";
        $("shell").hidden = space === "face";
        document
          .querySelectorAll("[data-space]")
          .forEach((button) => {
            button.setAttribute("aria-current", button.dataset.space === space ? "page" : "false");
            if (button.classList.contains("nav-btn")) button.classList.toggle("active", button.dataset.space === space);
          });
        Object.keys(titles).forEach((key) => ($(key + "Space").hidden = key !== space));
        if (space !== "face") {
          $("spaceTitle").innerHTML =
            esc(titles[space][0]) + waveSvg(9);
          $("spaceSub").textContent = titles[space][1];
          renderSpaces();
          void refresh();
        } else $("faceHit").focus();
        if (changed && typeof window !== "undefined") window.scrollTo(0, 0);
      }
      function gaze(target) {
        const r = target.getBoundingClientRect();
        const m = $("mini").getBoundingClientRect();
        $("mini").style.setProperty(
          "--mx",
          Math.max(-7, Math.min(7, (r.x + r.width / 2 - m.x) / 70)) + "px",
        );
        $("mini").style.setProperty(
          "--my",
          Math.max(-4, Math.min(4, (r.y + r.height / 2 - m.y) / 70)) + "px",
        );
      }
      function empty(message) {
        return '<div class="empty">' + esc(message) + "</div>";
      }
      function badge(status) {
        const labels = {
          confirmed: "已确认事实",
          observed: "观察记录",
          inferred: "模型推测",
          candidate: "待确认",
          retracted: "已撤回",
          superseded: "已更新",
          succeeded: "已回读完成",
          running: "执行中",
          queued: "排队中",
          awaiting_approval: "等待审批",
          cancelling: "请求取消中",
          cancelled: "已确认停止",
          unknown: "结果待核实",
          failed: "执行失败",
          active: "规则已确认",
          revoked: "已撤销",
        };
        return (
          '<span class="tag ' +
          (["confirmed", "succeeded", "active"].includes(status)
            ? "green"
            : ["failed", "revoked", "retracted"].includes(status)
              ? "coral"
              : ["inferred", "candidate", "awaiting_approval", "cancelling", "unknown"].includes(
                    status,
                  )
                ? "amber"
                : "") +
          '">' +
          esc(labels[status] || status) +
          "</span>"
        );
      }
      const sourceLabels = { authenticated_user_statement: "主人亲口确认", active_look_capture: "视觉抓拍 + 语音", passive_observation: "桌面视觉观察", pattern_inference: "近期习惯推断", inferred: "近期习惯推断", app_context: "应用画面记录", camera_frame: "桌面视觉观察", vision_description: "视觉内容分析", user_statement: "语音记录" };
      function humanSource(value) { return sourceLabels[value] || "来源待核实"; }
      function humanWorkspace(value) { return ({ ws_godot_island: "Godot 海岛工程", workspace_study: "书房工作区", project_study: "书房项目", proj_island: "Godot 海岛工程" })[value] || (value ? "项目工作区" : "尚未指定工作区"); }
      function humanEntity(id) { return state.entities.find((e) => e.entity_id === id)?.friendly_name || ({ "light.study_ceiling": "书房吸顶灯", "light.study_desk": "书房台灯", "fan.study_fresh_air": "书房新风", "switch.desk_fan": "桌面风扇" })[id] || "家居设备"; }
      function humanCondition(value) {
        const condition = clean(value).trim();
        if (condition === "web_study" || /^context\s*==\s*["']web_study["']$/.test(condition)) return "进入书房学习时";
        if (/^[\u3400-\u9fff\s，。；、0-9]+$/.test(condition)) return condition;
        return "满足已确认的触发条件时";
      }
      function humanDesired(value) {
        let desired = value;
        if (typeof desired === "string") { try { desired = JSON.parse(desired); } catch { return "按已确认的设备偏好调节"; } }
        if (!desired || typeof desired !== "object") return "按已确认的设备偏好调节";
        const attrs = { ...desired, ...(desired.service_data || {}) };
        const parts = [attrs.service === "turn_off" ? "自动关闭" : attrs.service === "turn_on" ? "自动开启" : "自动调节"];
        if (Number.isFinite(Number(attrs.brightness)) && attrs.brightness != null) parts.push("亮度 " + Math.round(Math.max(0, Math.min(255, Number(attrs.brightness))) / 255 * 100) + "%");
        if (Number.isFinite(Number(attrs.color_temp_kelvin)) && attrs.color_temp_kelvin != null) {
          const k = Number(attrs.color_temp_kelvin); parts.push(k + "K " + (k <= 3000 ? "暖白光" : k <= 4500 ? "自然白光" : "冷白光"));
        }
        return parts.join(" · ");
      }
      function humanTaskSummary(value) {
        const summary = clean(value);
        const succeeded = summary.match(/Task succeeded with (\d+) verified artifacts/i);
        if (succeeded) return "任务已完成 · " + succeeded[1] + " 项产物已回读核验";
        if (/High-risk command requires user approval/i.test(summary)) return "检测到高危命令，等待主人单次授权";
        if (/Cancellation in progress/i.test(summary)) return "取消请求已发出，等待退出证据";
        return summary || "尚无进展回报";
      }
      function humanArtifact(value) { return ({ art_checklist: "道路与阶梯核查清单", art_app: "Godot 构建产物包", art_html5_zip: "网页游戏构建包" })[value] || "已核验任务产物"; }
      function relativeTime(value) {
        const timestamp = Date.parse(value); if (!Number.isFinite(timestamp)) return "时间待核实";
        const minutes = Math.floor((Date.now() - timestamp) / 60000);
        if (minutes < 0) return date(value);
        if (minutes < 1) return "刚刚";
        if (minutes < 60) return minutes + " 分钟前";
        if (minutes < 1440) return Math.floor(minutes / 60) + " 小时前";
        if (minutes < 2880) return "昨天";
        return Math.floor(minutes / 1440) + " 天前";
      }
      function waveSvg(bars = 9) {
        const heights = bars === 7 ? [3,7,15,27,15,7,3] : [2,5,11,20,30,20,11,5,2];
        return '<svg class="wave-ornament" viewBox="0 0 72 32" aria-hidden="true"><g stroke="currentColor" stroke-width="2" stroke-linecap="round">' + heights.map((h,i) => '<path opacity="' + (.25 + .75 * h / 30) + '" d="M' + (6 + i * 60 / (bars - 1)) + ' ' + (16 - h / 2) + 'v' + h + '"/>').join('') + '</g></svg>';
      }
      function resolveMemorySceneTarget(whereText, itemTitle) {
        const where = clean(whereText).trim();
        if (/拿走|未知|不详|未记录|未确认|屏幕|不在|不是|非真实/.test(where)) return { key: null, cx: null, cy: null, label: "位置尚未定位" };
        if (/键盘.*左|keyboard_left/i.test(where)) return { key: "keyboard_left", cx: 111, cy: 132, label: "键盘左侧" };
        if (/显示器.*右|monitor_right/i.test(where)) return { key: "monitor_right", cx: 287, cy: 104, label: "显示器右侧" };
        if (/书架|bookshelf/i.test(where)) return { key: "bookshelf", cx: 58, cy: 66, label: "书架" };
        if (/右.*抽屉|抽屉.*右|drawer_right/i.test(where)) return { key: "drawer_right", cx: 331, cy: 153, label: "右侧抽屉" };
        return { key: null, cx: null, cy: null, label: "位置尚未定位" };
      }
      let illustrationSequence = 0;
      function memoryIllustration(target) {
        const uid = 'memory-scene-' + ++illustrationSequence;
        const key = target.key;
        const common = '<defs><linearGradient id="' + uid + '-desk" x2="0" y2="1"><stop stop-color="#122638"/><stop offset="1" stop-color="#030a12"/></linearGradient><radialGradient id="' + uid + '-glow"><stop stop-color="#1779b1" stop-opacity=".42"/><stop offset="1" stop-color="#030a12" stop-opacity="0"/></radialGradient><linearGradient id="' + uid + '-metal" x2=".3" y2="1"><stop stop-color="#c5d2df"/><stop offset=".4" stop-color="#6c8194"/><stop offset="1" stop-color="#263c50"/></linearGradient></defs><rect width="480" height="270" fill="#030a12"/><ellipse cx="270" cy="190" rx="260" ry="150" fill="url(#' + uid + '-glow)"/><path d="M0 106 480 80v190H0Z" fill="url(#' + uid + '-desk)"/><path d="M0 241 480 216" stroke="#214962" stroke-opacity=".5"/>';
        let artwork;
        if (key === 'keyboard_left') {
          artwork = '<g transform="translate(245 82) rotate(-9)"><path d="M-4 2h230l28 140H7Z" fill="#02070e" stroke="#24668a" stroke-width="2"/><path d="m9 145 246-2" stroke="#19b6ff" stroke-width="3"/>' + Array.from({length: 42}, (_,i) => '<rect x="' + (8 + i%7*31 + Math.floor(i/7)*2) + '" y="' + (11 + Math.floor(i/7)*21) + '" width="23" height="15" rx="3" fill="#142b41" stroke="#1b76a3" stroke-width="1"/>').join('') + '</g><ellipse cx="148" cy="187" rx="82" ry="22" fill="#00111d"/><g transform="translate(97 130) rotate(24 45 25)"><path d="M7 11 26 0h39l13 15v22L63 49H44v58l-10 9-9-9V49L8 37Z" fill="url(#' + uid + '-metal)" stroke="#b9d8e6" stroke-width="2"/><circle cx="44" cy="22" r="11" fill="#081521" stroke="#d0e5ee"/><path d="M34 62h9m-9 16h9m-9 15h9" stroke="#28d5ff" stroke-width="3"/></g><path d="M82 211q57 21 112-5" fill="none" stroke="#28d5ff" stroke-opacity=".28"/>';
        } else if (key === 'monitor_right') {
          artwork = '<g transform="translate(30 30)"><path d="M0 5Q120-8 240 5v120Q120 135 0 125Z" fill="#020711" stroke="#3f6079" stroke-width="3"/><path d="M10 16h220v98H10Z" fill="#0a2440"/><path d="M12 102Q97 25 230 68M12 87Q140 25 230 51" fill="none" stroke="#157fbc" stroke-opacity=".45"/><path d="M113 130v39h-44v7h107v-7h-45v-39" fill="#243e55"/></g><g transform="translate(291 129) rotate(-8)"><path d="M0 0h115v83H0Z" fill="#172838" stroke="#7790a2"/><path d="M6 6h101v70H6Z" fill="#9bafb7"/><path d="M20 22h69m-69 13h69m-69 13h48" stroke="#526e82" stroke-width="2"/><path d="M3 0v83" stroke="#0b1724" stroke-width="5"/></g><rect x="274" y="214" width="125" height="4" rx="2" fill="#28d5ff" opacity=".5"/>';
        } else if (key === 'bookshelf') {
          artwork = '<path d="M50 28h380v223H50Z" fill="#091320" stroke="#294459" stroke-width="4"/><path d="M53 117h374v10H53Zm0 101h374v13H53Z" fill="#2b4358"/><path d="M56 127h365M56 231h365" stroke="#25bde8" stroke-opacity=".65"/>' + Array.from({length: 10},(_,i) => '<g transform="translate(' + (77 + i%5*34 + (i>=5?115:0)) + ' ' + (i<5?43:143) + ')"><rect width="25" height="' + (i%2?65:72) + '" rx="2" fill="' + ['#164569','#18324d','#34576c'][i%3] + '"/><path d="M6 8v42m4 12h10" stroke="#91aebd" opacity=".5"/></g>').join('') + '<g transform="translate(293 51)"><rect width="47" height="63" rx="10" fill="url(#' + uid + '-metal)"/><rect x="-2" y="-4" width="51" height="12" rx="5" fill="#152c40"/><path d="M6 18v30" stroke="#c7edfa" opacity=".5"/></g>';
        } else if (key === 'drawer_right') {
          artwork = '<path d="M24 39h420v37H24Z" fill="#1d3448" stroke="#49677d"/><path d="M47 76h374v143H47Z" fill="#07111c"/><path d="m78 99 295-2 45 124H38Z" fill="#142a3e" stroke="#456781" stroke-width="2"/><path d="m38 221 380 0-4 32H43Z" fill="#213c52"/><path d="M197 235h66" stroke="#8296a7" stroke-width="5" stroke-linecap="round"/><g transform="translate(164 107) rotate(-12)"><rect width="90" height="116" rx="5" fill="#123d59" stroke="#3189ab"/><circle cx="45" cy="43" r="17" fill="none" stroke="#c6ad6c"/><path d="M28 43h34M45 26q-15 17 0 34m0-34q15 17 0 34M23 77h44m-36 11h28" fill="none" stroke="#c6ad6c"/><text x="45" y="104" text-anchor="middle" fill="#d3c294" font-size="8" letter-spacing="3">PASSPORT</text></g><path d="m52 219 350 0" stroke="#28d5ff" stroke-opacity=".55" stroke-width="2"/>';
        } else artwork = '<rect x="145" y="53" width="190" height="124" rx="22" fill="#071623" stroke="#285371"/><circle cx="202" cy="111" r="16" fill="#28d5ff" opacity=".7"/><circle cx="278" cy="111" r="16" fill="#28d5ff" opacity=".7"/><path d="M226 145q14 10 28 0" fill="none" stroke="#28d5ff" stroke-width="3"/><text x="240" y="221" text-anchor="middle" fill="#7894aa" font-size="12">位置未定位 · 保留记录原意</text>';
        return '<svg viewBox="0 0 480 270" role="img" aria-label="' + esc(target.label) + '场景插画，非真实抓拍">' + common + artwork + '</svg>';
      }
      function desktopDiagram(target) {
        const zones = { keyboard_left: [80,111,62,42], monitor_right: [264,79,55,49], bookshelf: [28,34,60,65], drawer_right: [302,132,62,36] };
        const zone = zones[target.key];
        const highlight = zone ? '<rect x="' + zone[0] + '" y="' + zone[1] + '" width="' + zone[2] + '" height="' + zone[3] + '" rx="8" fill="#28d5ff" fill-opacity=".12" stroke="#28d5ff" stroke-opacity=".5"/>' : '';
        const crosshair = target.key ? '<g fill="none" stroke="#28D5FF"><circle cx="' + target.cx + '" cy="' + target.cy + '" r="18" opacity=".3" class="target-pulse"/><circle cx="' + target.cx + '" cy="' + target.cy + '" r="12" stroke-dasharray="3 3"/><circle cx="' + target.cx + '" cy="' + target.cy + '" r="3" fill="#28D5FF"/><path d="M' + (target.cx-25) + ' ' + target.cy + 'h13m24 0h13M' + target.cx + ' ' + (target.cy-25) + 'v13m0 24v13"/></g>' : '';
        return '<svg class="scene" viewBox="0 0 400 200" role="img" aria-label="' + esc(target.label) + '，历史记忆位置示意，非实时定位"><g stroke="#305570" fill="#0b1a28"><rect x="23" y="31" width="354" height="145" rx="12"/><rect x="32" y="38" width="51" height="58" rx="4"/><path d="M34 65h46M44 44v18m9-18v18m10-18v18m-18 8v16m12-16v16"/><rect x="143" y="43" width="117" height="66" rx="6"/><path d="M196 109v11h-26m26 0h36"/><rect x="147" y="129" width="119" height="22" rx="4"/><path d="M156 135h97m-97 8h97"/><rect x="277" y="86" width="30" height="37" rx="3"/><path d="M283 95h18m-18 7h18m-18 7h18"/><rect x="306" y="137" width="54" height="28" rx="5"/><path d="M326 150h16"/></g>' + highlight + crosshair + '<text x="24" y="191" fill="#718da5" font-size="10">历史位置示意 · ' + esc(target.label) + ' · 非实时定位</text></svg>';
      }
      function cancellationBanner(event, status, locallyRequested = false) {
        const phase = event?.cancellation?.phase;
        if (!locallyRequested && status !== "cancelling" && event?.state !== "cancelled" && (!phase || phase === "not_requested")) return "";
        if (status === 'cancelled' && cancellationConfirmed(event)) return '<div class="cancel-banner safe"><strong class="green">已安全中止</strong><p>已确认停止 · 远端进程退出证据已回读。</p></div>';
        if (status !== 'unknown' && phase === 'too_late') return '<div class="cancel-banner late"><strong class="coral">不可安全撤回</strong><p>操作已完成，取消已来不及；请核查完成回执。</p></div>';
        if (status !== 'unknown' && (status === 'cancelling' || phase === 'pending')) return '<div class="cancel-banner"><strong class="amber">已请求取消</strong><p>等待远端进程退出证据，尚未确认停止。</p></div>';
        if (status === 'unknown' || phase === 'unknown' || event?.state === 'cancelled') return '<div class="cancel-banner"><strong class="amber">取消结果待核实</strong><p>缺少有效退出证据，不能声称已停止。</p></div>';
        return '';
      }
      function quickCount(key) {
        if (key === 'memories') return state.claims.filter((c) => !['retracted','superseded'].includes(c.status)).length + ' 条记录';
        if (key === 'tasks') return state.tasks.filter((t) => ['queued','running','awaiting_approval','cancelling'].includes(taskState(t))).length + ' 项进行中';
        if (key === 'home') return (new Set(state.entities.map((e) => e.device_id).filter(Boolean)).size || state.entities.length) + ' 台设备' + (state.homeMode === 'simulation' ? ' · 仿真' : '');
        return state.report && validReport(state.report) ? state.report.passedCases + '/48 通过' : state.running ? '48 项核验中' : '48 项待核验';
      }
      function updateQuickCounts() {
        document.querySelectorAll('[data-quick-count]').forEach((element) => { element.textContent = quickCount(element.dataset.quickCount); });
      }
      function renderHardwareHealth() {
        const telemetry = state.status?.hardware;
        const dx = Number.isFinite(telemetry?.driftX) ? Math.max(-6, Math.min(6, telemetry.driftX)) : null;
        const dy = Number.isFinite(telemetry?.driftY) ? Math.max(-6, Math.min(6, telemetry.driftY)) : null;
        const thermal = Number.isFinite(telemetry?.temperatureC) ? telemetry.temperatureC : null;
        const dot = dx !== null && dy !== null ? '<circle cx="' + (60 + dx * 7) + '" cy="' + (60 - dy * 7) + '" r="4" fill="#28D5FF" style="filter:drop-shadow(0 0 5px #28D5FF)"/>' : '';
        $('hardwareHealth').innerHTML = '<h2>热状态与 OLED 位移</h2><p class="caption">硬件遥测 · 与浏览器动画独立</p><div class="health-row"><svg class="drift-radar" viewBox="0 0 120 120" role="img" aria-label="OLED 位移坐标，范围负 6 到正 6 像素"><rect x="13" y="13" width="94" height="94" rx="12" fill="#050e19" stroke="#28445e"/><g fill="none" stroke="#244359" stroke-width=".7"><path d="M18 32h84M18 46h84M18 74h84M18 88h84M32 18v84M46 18v84M74 18v84M88 18v84"/><circle cx="60" cy="60" r="32"/><path d="M18 60h84M60 18v84" stroke="#3681a5"/></g><g fill="#7493aa" font-size="8"><text x="2" y="63">−6</text><text x="104" y="63">+6</text><text x="54" y="9">+6</text><text x="54" y="118">−6</text></g>' + dot + '</svg><div style="min-width:0;flex:1"><div class="sensor-value">' + (thermal === null ? '—' : esc(thermal)) + ' <small>°C</small></div><p class="caption">' + (thermal === null ? '热状态尚未接入' : '设备温度回读') + '</p><div class="meter"><span style="width:' + (thermal === null ? 0 : Math.max(0,Math.min(100,thermal))) + '%"></span></div><p class="caption">位移 ' + (dx === null || dy === null ? '— / —' : esc(dx) + ' / ' + esc(dy)) + ' px</p></div></div><p class="caption" style="margin-top:14px">' + (dx === null || dy === null ? '未取得端侧 OLED 遥测；坐标盘不虚构当前位置。' : '坐标范围 −6 至 +6 px，来自设备回读。') + '</p>';
      }
      function renderMobilePanes() {
        $("memoriesSpace").dataset.pane = state.mobileMemoryPane;
        $("tasksSpace").dataset.pane = state.mobileTaskPane;
        document.querySelectorAll("[data-memory-pane]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.memoryPane === state.mobileMemoryPane)));
        document.querySelectorAll("[data-task-pane]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.taskPane === state.mobileTaskPane)));
      }
      function setMemoryPane(pane, reveal = false) {
        if (!["list", "inspector"].includes(pane)) return;
        state.mobileMemoryPane = pane;
        renderMobilePanes();
        if (reveal) {
          $("memoryTabs").scrollIntoView({ block: "start" });
          if (pane === "inspector") $("memoryInspector").focus({ preventScroll: true });
          else $("memoryTabs").querySelector?.('[data-memory-pane="list"]')?.focus({ preventScroll: true });
        }
      }
      function setMobileTaskPane(pane, reveal = false) {
        if (!["tasks", "decisions"].includes(pane)) return;
        state.mobileTaskPane = pane;
        renderMobilePanes();
        if (reveal) $("taskTabs")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
      }
      function renderMemories() {
        renderMobilePanes();
        const query = $("memorySearch").value.trim().toLowerCase();
        const claims = state.claims.filter((c) => !["retracted", "superseded"].includes(c.status) && (state.filter === "all" || c.status === state.filter) && JSON.stringify(c.object).toLowerCase().includes(query));
        if (!claims.some((c) => c.claim_id === state.selected)) state.selected = claims[0]?.claim_id || null;
        $("memoryList").innerHTML = claims.length ? claims.map((c) => {
          const target = resolveMemorySceneTarget(c.object?.location, c.object?.target);
          const trust = c.status === 'confirmed' ? '高把握' : c.status === 'inferred' ? '待验证' : '历史观察';
          return '<button class="card glass select-card memory-card ' + (c.claim_id === state.selected ? 'selected' : '') + '" data-claim="' + esc(c.claim_id) + '" aria-pressed="' + (c.claim_id === state.selected) + '"><div class="memory-media">' + memoryIllustration(target) + '<span class="media-pill time">' + esc(relativeTime(c.observed_at)) + '</span><span class="media-pill trust">' + trust + ' · ' + esc(humanSource(c.source_kind)) + '</span></div><div class="memory-copy"><div class="row spread"><h3>' + esc(c.object?.target || c.predicate) + '</h3>' + badge(c.status) + '</div><p>' + esc(c.object?.location || c.object?.text || '未记录位置') + '</p><div class="source-line">' + waveSvg(7) + '<span>' + esc(humanSource(c.source_kind)) + '</span><span style="margin-left:auto" class="muted">场景示意</span></div><div class="raw-footer">' + (c.object?.simulation || c.claim_id.includes('demo') ? '演示记录 · ' : '') + '修订 ' + esc(c.revision) + ' · ' + esc(c.claim_id) + '</div></div></button>';
        }).join('') : empty(state.errors.memories ? '记忆读取失败，请等待重试。' : '还没有匹配的记忆。只有 Hub 返回的记录会出现在这里。');
        const back = '<button class="mobile-back pill-btn" data-memory-pane="list">← 返回记忆列表</button>';
        const c = claims.find((c) => c.claim_id === state.selected);
        if (!c) { $("memoryInspector").innerHTML = back + '<h2>证据检视器</h2><p>选择一条记忆，查看时间、位置、来源与可信边界。</p>'; return; }
        const target = resolveMemorySceneTarget(c.object?.location, c.object?.target);
        $("memoryInspector").innerHTML = back + '<div class="row spread" style="margin-top:0"><h2>证据检视器</h2>' + badge(c.status) + '</div>' + desktopDiagram(target) + '<h3>' + esc(c.object?.target || c.predicate) + '</h3><dl class="evidence-grid"><div class="evidence-dimension"><dt>观察时间</dt><dd>' + date(c.observed_at) + '</dd></div><div class="evidence-dimension"><dt>空间位置</dt><dd>' + esc(c.object?.location || '未记录位置') + '</dd></div><div class="evidence-dimension"><dt>记忆依据</dt><dd>' + esc(humanSource(c.source_kind)) + '</dd></div><div class="evidence-dimension"><dt>认识边界</dt><dd>' + (c.status === 'confirmed' ? '这条记录已确认；物品之后仍可能被移动。' : '历史观察或推测，不能视为此刻的确定位置。') + (c.source_availability !== 'retained' ? '<br><span class="amber">原始证据已过期，仅保留结构化记录。</span>' : '') + '</dd></div></dl><div class="row memory-actions"><button data-memory="correct">不是这里</button><button data-memory="taken">已经拿走了</button><button data-memory="forget" class="danger">忘掉这条</button></div><form id="correctionForm" class="inline-form" hidden><input id="correctLocation" required maxlength="180" aria-label="正确位置" placeholder="输入实际位置"><button type="submit">确认修正</button><button type="button" data-memory="cancel-correct">取消</button></form><div class="raw-footer">' + (c.claim_id.includes('demo') ? 'Hub 演示记忆 · ' : '') + '修订 ' + esc(c.revision) + ' · ' + date(c.revised_at) + '<br>证据引用 ' + esc((c.evidence_ids || []).join(' · ') || '无证据引用') + '<br>' + esc(c.source_kind) + '</div>';
      }
      function cancellationConfirmed(event) {
        return (
          event?.state === "cancelled" &&
          event.cancellation?.phase === "confirmed" &&
          Array.isArray(event.cancellation.termination_evidence_ids) &&
          event.cancellation.termination_evidence_ids.length > 0
        );
      }
      function taskState(task) {
        const event = state.taskEvents[task.task_id];
        return (
          state.cancels[task.task_id] ||
          (event?.state === "cancelled" && !cancellationConfirmed(event)
            ? "unknown"
            : event?.state) ||
          "unknown"
        );
      }
      function renderTasks() {
        renderMobilePanes();
        $("taskList").innerHTML = state.tasks.length ? state.tasks.map((task) => {
          const event = state.taskEvents[task.task_id]; const s = taskState(task);
          return '<article class="card glass" tabindex="0" data-gaze><div class="row spread" style="margin-top:0"><h3>' + esc(task.intent) + '</h3>' + badge(s) + '</div><span class="tag">' + esc(humanWorkspace(task.workspace_id)) + '</span><div class="task-state">' + esc(s === 'cancelling' ? '请求取消中，等待进程退出证据' : s === 'unknown' ? '结果待核实；请等待 Hub 重连回读' : humanTaskSummary(event?.summary)) + '</div>' + cancellationBanner(event, s, !!state.cancels[task.task_id]) + (event?.artifact_refs?.length ? '<p class="caption">已核验产物</p>' + event.artifact_refs.map((a) => '<span class="artifact-pill">' + icon('check') + esc(humanArtifact(a.artifact_id)) + ' · 已回读</span><div class="raw-footer">' + esc(a.artifact_id) + ' · ' + date(a.verified_at) + '<br>' + esc((a.evidence_ids || []).join(' · ')) + '</div>').join('') : '<p class="caption">尚无已核验产物</p>') + (cancellationConfirmed(event) ? '<div class="raw-footer">退出证据 ' + esc(event.cancellation.termination_evidence_ids.join(' · ')) + '</div>' : '') + (!['succeeded','failed','cancelled'].includes(s) ? '<div class="row"><button class="danger" data-cancel="' + esc(task.task_id) + '" ' + (s === 'cancelling' ? 'disabled' : '') + '>请求取消</button></div>' : '') + '<div class="raw-footer">' + (task.task_id.includes('demo') ? '演示任务 · ' : '') + esc(task.workspace_id || '') + ' · ' + esc(task.task_id) + '<br>事件 ' + esc(event?.event_seq ?? '—') + ' · ' + date(event?.recorded_at) + '</div></article>';
        }).join('') : empty(state.errors.tasks ? '任务读取失败，请等待重试。' : '暂无 Hub 任务。');
        const pending = state.tasks.filter((t) => taskState(t) === 'awaiting_approval');
        if (pending.length && !state.autoFocusedApproval) {
          state.autoFocusedApproval = true;
          setMobileTaskPane("decisions");
        } else if (!pending.length) state.autoFocusedApproval = false;
        $("pendingApprovalBadge").hidden = !pending.length;
        $("pendingApprovalBadge").textContent = pending.length + " 待审批";
        $("approvalPanel").innerHTML = '<h2>' + icon('shield') + '高危作用域审批</h2>' + (!pending.length ? '<p>暂无待审批命令。需要主人决定时，会在这里停下来。</p>' : pending.map((t) => {
          const g = (state.grants[t.task_id] || []).find((g) => g.status === 'active' && Date.parse(g.expires_at) > Date.now() && Date.parse(g.not_before) <= Date.now());
          return '<div class="rule" data-gaze><span class="tag amber">单次授权 · 等待明确确认</span><h3 style="margin-top:14px">' + esc(t.intent) + '</h3><dl class="evidence-grid"><div class="evidence-dimension"><dt>读取范围</dt><dd>' + esc(humanWorkspace(g?.scope?.project_id || t.scope?.project_id)) + '<br><small>未提供具体读取路径</small></dd></div><div class="evidence-dimension"><dt>写入目标</dt><dd>' + esc(humanWorkspace(t.workspace_id)) + '<br><small>具体文件范围尚未提供</small></dd></div></dl><p class="caption amber">拦截高危指令 / 任务请求</p><p class="mono command-box">' + esc((state.taskEvents[t.task_id]?.summary || t.intent).replace(/^High-risk command requires user approval[:：]?\s*/i, '')) + '</p><div class="row"><button data-approve="' + esc(t.task_id) + '" data-grant="' + esc(g?.grant_id || '') + '" ' + (!g ? 'disabled' : '') + '>单次批准并继续</button><button class="danger" data-cancel="' + esc(t.task_id) + '">拒绝并中止</button></div><p class="caption" style="margin-top:12px">授权边界 · ' + (g ? esc(g.max_uses) + ' 次 · 截止 ' + date(g.expires_at) : '未获取有效授权，不能批准') + '</p><p class="caption">批准仅解除此任务审批等待；完成仍需独立回读。</p><p class="caption" style="margin-top:10px">拒绝后发起取消；只有收到退出证据才确认中止。</p><div class="raw-footer">' + esc(g?.scope?.project_id || t.scope?.project_id || '') + ' · ' + esc(t.workspace_id || '') + '</div></div>';
        }).join(''));
        $("rulesList").innerHTML = state.rules.length ? state.rules.map((r) => '<div class="rule"><div class="row spread" style="margin-top:0"><h3>' + esc(humanEntity(r.entity_id)) + '</h3>' + badge(r.status) + '</div><p>' + esc(humanCondition(r.condition)) + '</p><p style="color:#b9e8f6">' + esc(humanDesired(r.desired_state)) + '</p>' + (r.status === 'active' ? '<div class="row"><button data-revoke="' + esc(r.rule_id) + '" class="danger">撤销约定</button></div>' : '') + '<div class="raw-footer">' + esc(r.entity_id) + ' · ' + esc(r.rule_id) + '</div></div>').join('') : empty('还没有已确认的日常约定。');
      }
      function snapshot(id) {
        return state.snapshots.find((s) => s.entity_id === id);
      }
      function homeCard(entity, title, symbol) {
        const s = entity && snapshot(entity.entity_id);
        const offline = !!state.errors.home || state.homeHealthy === false;
        const available = !offline && !!s && !['unavailable','unknown'].includes(s.state);
        const isOn = available && s.state === 'on';
        const readLabel = offline ? '网关离线不可用' : available ? '状态已回读' : '等待回读';
        const brightness = Number(s?.attributes?.brightness);
        const hasBrightness = s?.attributes?.brightness != null && Number.isFinite(brightness);
        const percent = hasBrightness ? Math.max(0, Math.min(100, Math.round(brightness / 255 * 100))) : 0;
        const legacyTemperature = Number(s?.attributes?.color_temp);
        const kelvin = Number(s?.attributes?.color_temp_kelvin || (legacyTemperature > 1000 ? legacyTemperature : legacyTemperature > 0 ? Math.round(1000000 / legacyTemperature) : 0));
        const features = entity?.supported_features || [];
        const range = entity?.allowed_range?.color_temp_kelvin;
        const colorTemps = range ? [range[0], Math.round((range[0] + range[1]) / 2), range[1]] : [3000,4000,5500];
        const content = '<section class="card glass ' + (isOn ? 'home-on' : '') + '"><div class="row home-card-header" style="margin:0"><div class="cap-icon">' + icon(symbol) + '</div><h2>' + esc(title) + '</h2><span class="tag ' + (offline ? 'coral' : available ? 'green' : 'amber') + '">' + readLabel + '</span>' + (entity ? '<button class="device-switch" role="switch" aria-label="' + esc(title) + '开关" aria-checked="' + isOn + '" data-home="' + esc(entity.entity_id) + '" data-service="' + (isOn ? 'turn_off' : 'turn_on') + '"></button>' : '') + '</div><p>' + (available ? s.state === 'on' ? '已开启' : s.state === 'off' ? '已关闭' : esc(s.state) : entity ? '尚无可用设备状态' : '尚未注册此设备') + '</p>' + (features.includes('brightness') ? '<label class="caption" style="display:block;margin-top:18px">亮度 <output class="brightness-value" style="float:right;color:#b9f1ff">' + (hasBrightness ? percent + '%' : '未回报') + '</output><input class="brightness-track" style="--level:' + percent + '%" aria-label="' + esc(title) + '亮度" type="range" min="0" max="100" value="' + percent + '" data-brightness="' + esc(entity.entity_id) + '"></label><div class="row spread caption brightness-scale" style="margin-top:0"><span>0%</span><span>100%</span></div><div class="options">' + [25,50,75,100].map((n) => '<button class="pill-btn ' + (hasBrightness && percent === n ? 'selected' : '') + '" data-home="' + esc(entity.entity_id) + '" data-service="turn_on" data-level="' + n + '" aria-pressed="' + (hasBrightness && percent === n) + '">' + n + '%</button>').join('') + '</div>' : '') + (features.includes('color_temp') ? '<div class="options">' + colorTemps.map((k,i) => '<button class="pill-btn ' + (kelvin === k ? 'selected' : '') + '" data-home="' + esc(entity.entity_id) + '" data-service="turn_on" data-kelvin="' + k + '" aria-pressed="' + (kelvin === k) + '"><span class="temperature-dot" style="color:' + ['#FFB347','#F4F8FF','#7CE7FF'][i] + '"></span>' + k + ' K ' + ['暖白','自然光','冷白'][i] + '</button>').join('') + '</div>' : '') + (symbol === 'fan' ? '<div class="options"><button class="pill-btn ' + (isOn ? 'selected' : '') + '" data-home="' + esc(entity?.entity_id || '') + '" data-service="turn_on" aria-pressed="' + isOn + '">运行</button><button class="pill-btn ' + (available && !isOn ? 'selected' : '') + '" data-home="' + esc(entity?.entity_id || '') + '" data-service="turn_off" aria-pressed="' + (available && !isOn) + '">待机</button></div><p class="caption" style="margin-top:12px">此设备仅回报开关能力</p>' : '') + '<div class="raw-footer">' + esc(entity?.entity_id || '无可用实体') + '<span class="readback-time">' + date(s?.last_updated) + '</span></div></section>';
        return !available ? content.replace(/<(button|input)\b/g, '$& disabled') : content;
      }
      function renderHome() {
        const offline = state.homeHealthy === false || !!state.errors.home;
        $("homeSource").textContent = offline ? '网关离线不可用 · 保留的旧数值不代表当前设备状态' : state.homeMode === 'simulation' ? 'Hub 仿真适配器 · 以下是仿真设备回读' : state.homeMode === 'adapter' ? 'Hub 外部适配器回读 · 以各项更新时间为准' : '状态来源尚未确认';
        $("homeSearch").hidden = state.homeMode === 'simulation';
        $("homeMore").hidden = true;
        if (state.homeMode !== 'simulation') {
          const query = $("homeSearch").value.trim().toLowerCase();
          const rank = (entity) => entity.domain === 'light' ? 0 : entity.domain === 'fan' ? 1 : entity.domain === 'switch' ? 2 : 3;
          const entities = state.entities.filter((entity) => {
            if (query) return (entity.friendly_name + ' ' + (entity.room || '') + ' ' + (entity.device_name || '') + ' ' + entity.entity_id).toLowerCase().includes(query);
            if (entity.entity_category) return false;
            return (entity.supported_features || []).includes('turn_on') || ['climate','vacuum','media_player','humidifier'].includes(entity.domain)
              || ['temperature','humidity','carbon_dioxide','pm25'].includes(snapshot(entity.entity_id)?.attributes?.device_class);
          }).sort((a,b) => rank(a) - rank(b) || a.friendly_name.localeCompare(b.friendly_name, 'zh'));
          const limit = state.homeLimit || 40;
          $("homeGrid").innerHTML = entities.slice(0, limit).map((entity) => {
            if ((entity.supported_features || []).includes('turn_on')) return homeCard(entity, entity.friendly_name, entity.domain === 'light' ? 'light' : entity.domain === 'fan' ? 'fan' : 'sensor');
            const current = snapshot(entity.entity_id);
            const readable = !offline && current && !['unknown','unavailable'].includes(current.state);
            return '<section class="card glass"><h2>' + esc(entity.friendly_name) + '</h2><p class="sensor-value">' + (readable ? esc(current.state) + ' ' + esc(current.attributes.unit_of_measurement || '') : '—') + '</p><p class="caption">' + esc(entity.room || '') + ' · ' + (readable ? '只读状态' : '状态待核实') + '</p></section>';
          }).join('') || empty(query ? '没有匹配的设备' : '尚未读取到设备，请确认米家连接。');
          $("homeMore").hidden = entities.length <= limit;
          $("homeMore").textContent = '继续显示 · 还有 ' + Math.max(0, entities.length - limit) + ' 项';
          return;
        }
        const ceiling = state.entities.find((e) => e.entity_id === 'light.study_ceiling');
        const desk = state.entities.find((e) => e.entity_id === 'light.study_desk');
        const fan = state.entities.find((e) => e.entity_id === 'fan.study_fresh_air') || state.entities.find((e) => e.entity_id === 'switch.desk_fan');
        const sensors = state.entities.filter((e) => e.domain === 'sensor');
        $("homeGrid").innerHTML = homeCard(ceiling, '书房吸顶灯', 'light') + homeCard(desk, '书房台灯', 'light') + homeCard(fan, fan?.friendly_name || '新风系统', 'fan') + '<section class="card glass"><div class="cap-icon">' + icon('sensor') + '</div><h2>环境传感器</h2><p class="caption">独立回读 · 不以视觉推测补值</p><div class="sensor-grid">' + (sensors.length ? sensors.map((e) => {
          const s = offline ? null : snapshot(e.entity_id); const reading = s?.state != null && Number.isFinite(Number(s.state)) ? Number(s.state) : null;
          const max = /humidity/.test(e.entity_id) ? 100 : /co2/.test(e.entity_id) ? 2000 : /pm25/.test(e.entity_id) ? 150 : 50;
          const label = /temperature/.test(e.entity_id) ? '室内温度' : /humidity/.test(e.entity_id) ? '空气湿度' : /co2/.test(e.entity_id) ? '二氧化碳' : /pm25/.test(e.entity_id) ? '细颗粒物' : e.friendly_name;
          return '<div><p class="caption">' + esc(label) + '</p><div class="sensor-value">' + (reading === null ? '—' : esc(s.state)) + ' <small>' + esc(s?.attributes?.unit_of_measurement || '') + '</small></div><div class="meter"><span style="width:' + (reading === null ? 0 : Math.max(0,Math.min(100,reading/max*100))) + '%"></span></div><p class="caption">' + (offline ? '网关离线' : reading === null ? '等待数值' : '已回读') + '</p><div class="raw-footer">' + esc(e.entity_id) + '<br>' + date(s?.last_updated) + '</div></div>';
        }).join('') : '<p>尚无传感器注册</p>') + '</div></section>';
        $("homeProposals").innerHTML = state.proposals.map((p) => '<div class="rule"><span class="tag amber">待确认规则提案</span><h3 style="margin-top:12px">' + esc(humanEntity(p.entity_id || p.entityId)) + '</h3><p>' + esc(humanCondition(p.condition || p.context_pattern || p.context_hint || p.contextHint)) + ' · ' + esc(humanDesired(p.suggested_state)) + '</p><div class="row"><button data-confirm-rule="' + esc(p.proposal_id) + '">确认这项约定</button></div><div class="raw-footer">' + esc(p.proposal_id) + '</div></div>').join('');
      }
      function renderCabin() {
        const status = state.status;
        const hubOk = !!status && !state.errors.status;
        $("connections").innerHTML =
          '<section class="card glass"><div class="cap-icon">' +
          icon("link") +
          '</div><h3>本机中枢</h3><div class="connection-state ' +
          (hubOk ? "green" : "coral") +
          '">' +
          (hubOk ? "HTTP 已回读" : "未连接") +
          "</div><p>" +
          esc(hubOk ? "服务可达 · 各设备单独核实" : state.errors.status || "等待服务器") +
          '</p><p class="caption">' +
          date(state.lastRead) +
          '</p></section><section class="card glass"><div class="cap-icon">' +
          icon("dock") +
          '</div><h3>桌面代理</h3><div class="connection-state amber">未接入 Web</div><p>桌面执行器连接状态未提供；底座 BLE 回执也未接入。</p><p class="caption">验真时间 / 重放计数：未知</p></section><section class="card glass"><div class="cap-icon">' +
          icon("home") +
          '</div><h3>家居网关</h3><div class="connection-state ' +
          (state.errors.home || state.homeHealthy === false
            ? "coral"
            : state.homeMode === "simulation"
              ? "amber"
              : state.homeMode === "adapter"
                ? "green"
                : "amber") +
          '">' +
          (state.errors.home || state.homeHealthy === false
            ? "网关离线不可用"
            : state.homeMode === "simulation"
              ? "仿真适配器"
              : state.homeMode === "adapter"
                ? "设备接口已回读"
                : "尚未核实") +
          "</div><p>" +
          esc(
            state.homeMode === "simulation"
              ? "内存仿真回读，不代表实体网关连接。"
              : "连接真值以独立网关状态为准。",
          ) +
          '</p><p class="caption">' +
          date(status?.home?.lastVerifiedAt) +
          "</p></section>";
        for (const type of ["voice", "vision"]) {
          const provider = state[type];
          $(type + "Status").textContent = provider
            ? "当前选择：" + ({doubao:"豆包双工",modular:"模块化流式",cloud:"云端视觉",lan:"局域网视觉",edge:"端侧视觉"}[provider.active] || "待核实引擎") + " · 运行就绪需单独核实"
            : "未读取到引擎状态";
          $(type + "Options").innerHTML = (
            type === "voice" ? ["doubao", "modular"] : ["cloud", "lan", "edge"]
          )
            .map(
              (k) =>
                '<button data-provider="' +
                type +
                '" data-kind="' +
                k +
                '" class="pill-btn ' +
                (provider?.active === k ? "selected" : "") +
                '">' +
                esc(
                  {
                    doubao: "A · 豆包双工",
                    modular: "B · 模块化流式",
                    cloud: "云端",
                    lan: "局域网",
                    edge: "端侧",
                  }[k],
                ) +
                "</button>",
            )
            .join("");
        }
        renderHardwareHealth();
        renderReport();
      }
      function toggleReportDetails() { state.reportExpanded = !state.reportExpanded; state.reportGroup = null; renderReport(); }
      function selectReportGroup(group) {
        if (!/^[A-H]$/.test(group) || !state.report || !validReport(state.report)) return;
        state.reportGroup = group;
        state.reportExpanded = true;
        renderReport();
        $("reportDetails").scrollIntoView?.({ block: "nearest" });
      }
      function renderReport() {
        const rep = state.report && validReport(state.report) ? state.report : null;
        const names = ['物品位置与微观察','语音改口与去重','归属与自发声隔离','纠错删除与防写回','家居与真值','任务与取消','具身安全','长稳与降级'];
        $("runAcceptance").disabled = state.running;
        $("runAcceptance").innerHTML = icon('lab') + (state.running ? '正在运行…' : '运行 48 项验收');
        $("reportSummary").textContent = state.running ? '运行中 · 等待 Hub 完整报告' : rep ? rep.passedCases + ' / ' + rep.totalCases + ' 项通过 · ' + rep.totalScore + ' / ' + rep.maxScore + ' 分' + (rep.success ? '' : ' · 存在未通过项') : '尚未运行 · A–H 八组 / 四大硬门禁';
        $("acceptanceGrid").innerHTML = 'ABCDEFGH'.split('').map((group,index) => {
          const cases = rep?.cases.filter((c) => c.id.startsWith(group)) || [];
          const passed = cases.filter((c) => c.passed && c.score === 2).length;
          return '<button class="acceptance-group" data-group="' + group + '" aria-controls="reportDetails" aria-pressed="' + (state.reportExpanded && state.reportGroup === group) + '" ' + (rep ? '' : 'disabled') + '><div class="row spread"><span class="caption">' + group + ' · ' + names[index] + '</span><strong>' + (rep ? passed + '/6' : '—/6') + '</strong></div><div class="meter"><span style="width:' + (rep ? passed/6*100 : 0) + '%"></span></div><span class="caption">' + (rep ? passed === 6 ? '本组已通过' : '仍有待核查项' : '等待运行') + '</span></button>';
        }).join('');
        const policies = [['高风险命令审批','主人单次授权后才继续'],['家庭写操作确认','调节后独立核对设备回读'],['只读工具免打扰','状态与传感器安静同步'],['诚实取消语义','退出证据决定中止状态']];
        const gates = [['unauthorizedActions','越权执行'],['crossSubjectLeaks','跨主体泄露'],['zombieResurrections','僵尸复活'],['unverifiedCompletions','未核验成功']];
        $("gateGrid").innerHTML = policies.map(([title,description]) => '<div class="gate">' + icon('shield') + '<div>' + title + '</div><small>' + description + '</small></div>').join('') + '<div class="gate-report-row" aria-label="真实软件报告硬门禁计数">' + gates.map(([key,label]) => '<div><span class="caption">' + label + '</span><strong class="' + (rep ? rep.hardGates[key] === 0 ? 'green' : 'coral' : 'muted') + '">' + (rep ? rep.hardGates[key] : '—') + '</strong><span class="caption">' + (rep ? '报告计数' : '尚未核验') + '</span></div>').join('') + '</div>';
        $("toggleReport").textContent = (state.reportExpanded ? '收起' : '展开') + (state.reportExpanded && state.reportGroup ? ' ' + state.reportGroup + ' 组用例明细' : ' 48 项用例明细');
        $("toggleReport").setAttribute('aria-expanded', String(state.reportExpanded));
        $("reportDetails").hidden = !state.reportExpanded;
        $("reportDetails").innerHTML = rep ? rep.cases.filter((c) => !state.reportGroup || c.id.startsWith(state.reportGroup)).map((c) => '<div class="report-case"><span class="' + (c.passed ? 'green' : 'coral') + '">' + esc(c.id) + ' · ' + esc(c.name) + '</span><p>' + esc(c.details) + '</p></div>').join('') : '<p class="caption" style="margin-top:14px">尚未取得用例回执，请先运行 48 项验收。</p>';
        updateQuickCounts();
      }
      const renderSignatures = {};
      let lastRenderedSpace = null;
      let draggingSlider = false;
      function renderSpaces() {
        renderFace();
        updateQuickCounts();
        const error =
          state.errors[state.space] || (state.space === "cabin" ? state.errors.status : undefined);
        $("spaceError").hidden = !error;
        $("spaceError").textContent = error
          ? "读取失败：" + clean(error) + "。已显示的数据可能过期，正在重试。"
          : "";
        const signature = JSON.stringify(
          state.space === "memories"
            ? [state.claims, state.errors.memories]
            : state.space === "tasks"
              ? [state.tasks, state.taskEvents, state.grants, state.rules, state.cancels]
              : state.space === "home"
                ? [
                    state.entities,
                    state.snapshots,
                    state.homeMode,
                    state.homeHealthy,
                    state.errors.home,
                    state.proposals,
                  ]
                : [
                    state.status,
                    state.voice,
                    state.vision,
                    state.report,
                    state.running,
                    state.errors,
                  ],
        );
        const editing =
          (state.space === "home" && (draggingSlider || document.activeElement?.matches("#homeGrid input"))) ||
          (state.space === "memories" && (document.activeElement?.id === "correctLocation" ||
            ($("correctionForm") && !$("correctionForm").hidden)));
        if (
          !editing &&
          (lastRenderedSpace !== state.space || renderSignatures[state.space] !== signature)
        ) {
          if (state.space === "memories") renderMemories();
          if (state.space === "tasks") renderTasks();
          if (state.space === "home") renderHome();
          if (state.space === "cabin") renderCabin();
          renderSignatures[state.space] = signature;
          lastRenderedSpace = state.space;
        }
        $("ledgerStatus").textContent = state.lastRead
          ? "Hub 最近回读 " + date(state.lastRead) + " · " + state.claims.length + " 条记忆"
          : "等待 Hub 回读";
      }
      async function refresh() {
        if (refreshBusy || document.hidden) return;
        refreshBusy = true;
        const requests = [
          ["status", "/api/console/status"],
          ["memories", "/api/memory/claims"],
          ["tasks", "/api/tasks"],
          ["home", "/api/home/states"],
          ["entities", "/api/home/entities"],
          ["rules", "/api/home/rules"],
          ["voice", "/api/voice/providers"],
          ["vision", "/api/vision/providers"],
        ];
        const results = await Promise.allSettled(
          requests.map(async ([key, path]) => {
            try {
              const data = await api(path);
              delete state.errors[key];
              return { key, data };
            } catch (error) {
              state.errors[key] = error.message;
              throw error;
            }
          }),
        );
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const { key, data } = result.value;
          if (key === "status") {
            state.status = data;
            state.lastRead = new Date().toISOString();
          }
          if (key === "memories") state.claims = data.claims;
          if (key === "tasks") state.tasks = data.tasks;
          if (key === "home") {
            state.snapshots = (data.entities || []).map((e) => e.snapshot).filter(Boolean);
            state.homeMode = data.transportMode || "unknown";
            state.homeHealthy = data.healthy;
          }
          if (key === "entities") state.entities = data.entities;
          if (key === "rules") {
            state.rules = data.rules;
            state.proposals = data.proposals;
          }
          if (key === "voice" || key === "vision") state[key] = data;
        }
        await Promise.allSettled(
          state.tasks.map(async (t) => {
            try {
              const result = await api("/api/tasks/" + encodeURIComponent(t.task_id));
              state.taskEvents[t.task_id] = result.event;
              if (
                state.cancels[t.task_id] === "unknown" &&
                (cancellationConfirmed(result.event) ||
                  ["succeeded", "failed"].includes(result.event.state))
              )
                delete state.cancels[t.task_id];
              if (result.event.state === "awaiting_approval") {
                try {
                  const data = await api("/api/tasks/" + encodeURIComponent(t.task_id) + "/grants");
                  state.grants[t.task_id] = data.grants;
                } catch {
                  state.grants[t.task_id] = [];
                }
              }
            } catch {
              state.taskEvents[t.task_id] = undefined;
            }
          }),
        );
        refreshBusy = false;
        renderSpaces();
      }
      async function perform(work) {
        try {
          await work();
        } catch (error) {
          toast(
            "未完成：" + (error.name === "AbortError" ? "请求超时，结果待核实" : error.message),
            "coral",
          );
          expression("alarmed", 1800);
        }
      }
      async function memoryAction(action) {
        if (action === "cancel-correct") {
          $("correctionForm").hidden = true;
          return;
        }
        const c = state.claims.find((c) => c.claim_id === state.selected);
        if (!c) return;
        if (action === "correct") {
          $("correctionForm").hidden = false;
          $("correctLocation").focus();
          $("correctionForm").scrollIntoView?.({ block: "nearest" });
          return;
        }
        if (action === "forget") {
          if (!c.evidence_ids.length) throw new Error("这条记录没有可删除的证据引用");
          let count = 0;
          for (const id of c.evidence_ids) {
            const result = await api(
              "/api/memory/evidence/" + encodeURIComponent(id) + "/delete",
              {},
            );
            if (!result.success) throw new Error("证据删除未确认");
            count += result.retractedClaimsCount || 0;
          }
          toast("证据已删除 · " + count + " 条关联记录已撤回");
        } else {
          const result = await api(
            "/api/memory/claims/" + encodeURIComponent(c.claim_id) + "/correct",
            {
              newObject: { ...c.object, location: "主人已拿走", text: "主人确认物品已经拿走" },
              userEventId: userAction().event_id,
            },
          );
          if (!result.success) throw new Error("修正未确认");
          toast("已记录拿走事实 · 修订 " + result.claim.revision);
        }
        await refresh();
      }
      async function correctMemory(event) {
        event.preventDefault();
        const c = state.claims.find((c) => c.claim_id === state.selected);
        const location = $("correctLocation").value.trim();
        if (!c || !location) return;
        await perform(async () => {
          const result = await api(
            "/api/memory/claims/" + encodeURIComponent(c.claim_id) + "/correct",
            { newObject: { ...c.object, location }, userEventId: userAction().event_id },
          );
          if (!result.success) throw new Error("修正未确认");
          toast("位置已修正 · 修订 " + result.claim.revision);
          $("correctionForm").hidden = true;
          await refresh();
        });
      }
      async function cancelTask(id) {
        if (state.cancels[id] === "cancelling") return;
        state.cancels[id] = "cancelling";
        renderTasks();
        try {
          const data = await api("/api/tasks/" + encodeURIComponent(id) + "/cancel", {
            reason: "Web 主人明确请求取消",
          });
          state.taskEvents[id] = data.event;
          const confirmed =
            data.receipt?.status === "verified" &&
            data.event?.state === "cancelled" &&
            data.event?.cancellation?.phase === "confirmed" &&
            data.event.cancellation.termination_evidence_ids.length > 0;
          if (confirmed) {
            delete state.cancels[id];
            toast("已确认停止 · 进程退出证据已回读");
          } else {
            state.cancels[id] = data.event?.state === "cancelling" ? "cancelling" : "unknown";
            toast("取消结果待核实，未声称停止", "amber");
          }
        } catch (error) {
          state.cancels[id] = "unknown";
          toast("取消结果待核实：" + error.message, "amber");
        }
        renderTasks();
      }
      async function homeCommand(id, service, attributes = {}) {
        if (state.homeHealthy === false || state.errors.home) throw new Error("网关离线不可用");
        const entity = state.entities.find((e) => e.entity_id === id);
        if (!entity) throw new Error("设备尚未注册");
        $("homeFeedback").textContent = "等待设备回读…";
        const data = await api("/api/home/execute", {
          entity_id: id,
          domain: entity.domain,
          service,
          service_data: attributes,
        });
        const receipt = data.receipt;
        const rb = receipt?.readbacks?.find((r) => r.kind === "device_state");
        const expected = service === "turn_on" ? "on" : "off";
        const verified = receipt?.status === "verified" && rb?.value?.state === expected;
        const attributesMatch =
          verified &&
          Object.entries(attributes).every(([key, value]) => rb.value.attributes?.[key] === value);
        if (!verified) throw new Error(receipt?.reason_code || "尚无设备回读，结果待核实");
        const message =
          Object.keys(attributes).length && !attributesMatch
            ? "设备开关已回读，但参数尚未匹配；未声称调节成功"
            : "设备已回读 · " + (state.homeMode === "simulation" ? "仿真适配器" : "状态已核实");
        $("homeFeedback").textContent = message;
        toast(message, attributesMatch || !Object.keys(attributes).length ? "" : "amber");
        if (attributesMatch && Object.keys(attributes).length) {
          const adjustment = await api("/api/home/rules/adjustments", {
            entityId: id,
            service,
            serviceData: attributes,
            contextHint: "web_study",
          });
          if (adjustment.newProposal) toast("已生成偏好提案，请在书房家居确认", "amber");
        }
        await refresh();
      }
      function validReport(rep) {
        const ids = "ABCDEFGH"
          .split("")
          .flatMap((g) => Array.from({ length: 6 }, (_, i) => g + "0" + (i + 1)));
        return (
          rep &&
          rep.totalCases === 48 &&
          rep.maxScore === 96 &&
          Array.isArray(rep.cases) &&
          rep.cases.length === 48 &&
          ids.every((id) => rep.cases.filter((c) => c.id === id).length === 1) &&
          rep.cases.every(
            (c) =>
              typeof c.passed === "boolean" &&
              [0, 1, 2].includes(c.score) &&
              typeof c.name === "string" &&
              typeof c.details === "string",
          ) &&
          rep.passedCases === rep.cases.filter((c) => c.passed && c.score === 2).length &&
          rep.totalScore === rep.cases.reduce((sum, c) => sum + c.score, 0) &&
          [
            "unauthorizedActions",
            "crossSubjectLeaks",
            "zombieResurrections",
            "unverifiedCompletions",
          ].every((k) => Number.isInteger(rep.hardGates?.[k]) && rep.hardGates[k] >= 0) &&
          typeof rep.success === "boolean" &&
          (!rep.success ||
            (rep.passedCases === 48 &&
              rep.totalScore === 96 &&
              Object.values(rep.hardGates).every((n) => n === 0)))
        );
      }
      async function runAcceptance() {
        if (state.running) return;
        state.running = true;
        state.report = null;
        renderReport();
        expression("thinking");
        toast("48 项软件验收运行中");
        try {
          const rep = await api("/api/acceptance/run", {}, 120000);
          if (!validReport(rep)) throw new Error("验收报告不完整或计数不一致");
          state.report = rep;
          toast(
            rep.passedCases +
              "/48 项通过 · " +
              rep.totalScore +
              "/96 分" +
              (rep.success ? "" : " · 请查看未通过项"),
            rep.success ? "" : "amber",
          );
          expression(rep.success ? "curious" : "alarmed", 3000);
        } finally {
          state.running = false;
          renderReport();
          if (!state.report) expression("neutral");
        }
      }
      // An app-context record describes this rendered device face; it never claims camera provenance.
      async function recordSimulationSnapshot() {
        expression("thinking");
        const now = new Date().toISOString();
        const id = "demo_web_" + Date.now();
        const evidenceId = "evidence_" + id;
        const payload = {
          simulation: true,
          description: "LOOI 设备屏矢量示意快照，非相机抓拍",
          expression: state.privacy ? "sleeping" : state.speaking ? "speaking" : state.expression,
          dockedSimulation: state.docked,
        };
        const bytes = new TextEncoder().encode(JSON.stringify(payload));
        if (!globalThis.crypto?.subtle)
          throw new Error("此环境不能生成内容指纹，请使用 localhost 或 HTTPS");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const contentHash = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        const scope = {
          household_id: "household_default",
          subject_id: null,
          project_id: null,
          audience: "household",
          acl_policy_id: "default",
          acl_policy_revision: 1,
        };
        const event = {
          schema_version: "0.2",
          event_id: id,
          household_id: "household_default",
          subject_id: null,
          source_id: "web_simulation",
          source_device_id: sessionId,
          boot_epoch: sessionId,
          sequence: ++snapshotSequence,
          content_hash: contentHash,
          observed_at: now,
          monotonic_ms: performance.now(),
          monotonic_clock: "source_monotonic",
          received_at: now,
          time_uncertainty_ms: null,
          source_kind: "app_context",
          evidence_refs: [
            {
              evidence_id: evidenceId,
              revision: 1,
              source_event_id: id,
              derivation_root_id: id,
              episode_id: null,
              media_type: "application/json",
              captured_at: now,
              availability: "retained",
              object_ref: id,
              expires_at: null,
            },
          ],
          derivation_roots: [id],
          caused_by_action_id: null,
          parser_version: "presence-web-3.0",
          privacy_scope: scope,
          epoch_binding: {
            scope_id: "scope_web_simulation_" + sessionId,
            capture_epoch: null,
            deletion_generation: 0,
          },
          retention_policy: {
            policy_id: "web_simulation",
            revision: 1,
            expires_at: null,
            raw_expiry_behavior: "cascade",
          },
          payload,
        };
        const ingested = await api("/api/memory/events", event);
        if (!ingested.success) throw new Error("演示事件未被 Hub 接收");
        const claim = {
          schema_version: "0.2",
          claim_id: "claim_" + id,
          revision: 1,
          household_id: "household_default",
          subject_id: null,
          project_id: null,
          predicate: "simulation_screen_snapshot",
          object: {
            target: "设备屏示意快照 · 仿真",
            location: "此浏览器屏幕，非真实桌面",
            text: payload.description,
            simulation: true,
          },
          status: "observed",
          source_kind: "app_context",
          evidence_ids: [evidenceId],
          derivation_roots: [id],
          parent_claim_revisions: [],
          confidence: null,
          observed_at: now,
          valid_from: now,
          valid_to: null,
          recorded_at: now,
          revised_at: now,
          expires_at: null,
          supersedes: null,
          revision_reason: "initial",
          confirmed_by_user_event_id: null,
          source_availability: "retained",
          sensitivity: "ordinary",
          deletion_generation: 0,
          suppression_key: null,
        };
        const saved = await api("/api/memory/claims", claim);
        if (!saved.success) throw new Error("演示事件已入账，但快照记忆未保存");
        expression("curious", 2500);
        toast("设备屏示意已记入回忆册 · 仿真，非相机抓拍");
        await refresh();
      }
      let snapshotSequence = 0;
      function stopLocal(message) {
        state.motionGeneration++;
        state.motion = false;
        state.speaking = false;
        clearTimeout(speechTimer);
        expression("alarmed", 2200);
        toast(message || "急停演练：本页动画已停止；没有硬件停止回执", "coral");
        renderFace();
      }
      async function simulate(action) {
        closeSheet(false);
        switchSpace("face");
        if (action !== "speak") {
          state.speaking = false;
          clearTimeout(speechTimer);
          renderFace();
        }
        if (action === "stop") {
          stopLocal();
          return;
        }
        if (action === "acceptance") {
          await runAcceptance();
          return;
        }
        if (action === "speak") {
          state.speaking = !state.speaking;
          clearTimeout(speechTimer);
          renderFace();
          toast(state.speaking ? "说话动画测试 · 未连接麦克风或扬声器" : "说话动画测试结束");
          if (state.speaking)
            speechTimer = setTimeout(() => {
              state.speaking = false;
              renderFace();
              toast("说话演练结束");
            }, 5000);
          return;
        }
        if (action === "snapshot") {
          await recordSimulationSnapshot();
          return;
        }
        if (action === "dock") {
          state.docked = !state.docked;
          state.cutoff = state.docked ? null : new Date().toISOString();
          expression("curious", 2500);
          renderFace();
          toast(state.docked ? "归座演练 · 本页恢复陪伴" : "脱座演练 · 已记录本页观察截止时间");
          return;
        }
        if (action === "look") {
          if (!state.docked) throw new Error("脱座演练中，请先归座");
          const generation = ++state.motionGeneration;
          state.motion = true;
          expression("curious");
          renderFace();
          toast("Hub 仿真微观察运行中 · 不控制真实底座");
          try {
            const data = await api("/api/demo/active-look", {}, 15000);
            if (generation !== state.motionGeneration) return;
            toast(
              "仿真观察：" +
                (data.result?.found
                  ? "发现目标；结果已写入演示记忆"
                  : clean(data.result?.honestFallbackMessage || "未发现目标")),
            );
            expression("curious", 2500);
          } finally {
            if (generation === state.motionGeneration) {
              state.motion = false;
              renderFace();
            }
            void refresh();
          }
        }
      }
      function togglePrivacy() {
        closeSheet(false);
        switchSpace("face");
        state.privacy = !state.privacy;
        if (state.privacy) {
          state.motionGeneration++;
          state.motion = false;
          state.speaking = false;
          clearTimeout(speechTimer);
          if (typeof stopLiveVoice === "function") stopLiveVoice();
          if ($("askBar")) $("askBar").hidden = true;
        }
        renderFace();
        toast(state.privacy ? "此浏览器交互已暂停 · 远端硬件隐私状态未知" : "此浏览器交互已恢复");
      }
      function resetSheetDrag(animate = false) {
        sheetDrag = null;
        $("sheet").style.transition = animate ? "transform .2s ease-out" : "none";
        $("sheet").style.transform = "translateY(0)";
      }
      function startSheetDrag(point, target, source) {
        if (!state.sheet || target.closest("button, input, select, textarea, a") || sheetDrag) return;
        sheetDrag = { x: point.clientX, y: point.clientY, dy: 0, active: false, header: !!target.closest(".sheet-header, .handle"), source };
      }
      function moveSheetDrag(point, event, source) {
        if (!sheetDrag || sheetDrag.source !== source) return;
        const dx = point.clientX - sheetDrag.x;
        const dy = point.clientY - sheetDrag.y;
        sheetDrag.dy = dy;
        if (!sheetDrag.active && dy > 10 && dy > Math.abs(dx) * 1.2 && (sheetDrag.header || $("sheet").scrollTop <= 0)) {
          sheetDrag.active = true;
          clearTimeout(drawerTimer);
          $("sheet").style.transition = "none";
        }
        if (sheetDrag.active) {
          if (event.cancelable) event.preventDefault();
          $("sheet").style.transform = "translateY(" + Math.max(0, dy) + "px)";
        }
      }
      function finishSheetDrag(cancelled, source) {
        if (!sheetDrag || sheetDrag.source !== source) return;
        const dismiss = !cancelled && sheetDrag.active && sheetDrag.dy > 64;
        if (sheetDrag.active) suppressSheetClickUntil = Date.now() + 400;
        resetSheetDrag(!dismiss);
        if (dismiss) closeSheet();
        else armDrawer();
      }
      function startAmbientSwipe(event) {
        touchY = !state.motion && !state.privacy && !state.sheet && !event.target.closest("#motionStop, .corners") && event.touches.length === 1 ? event.touches[0].clientY : null;
      }
      function finishAmbientSwipe(event) {
        if (touchY !== null && touchY - (event.changedTouches[0]?.clientY ?? touchY) > 45 && !state.motion && !state.privacy && !state.sheet) openSheet("quick");
        touchY = null;
      }
      $("faceHit").addEventListener("click", () =>
        state.privacy ? togglePrivacy() : openSheet("quick"),
      );
      $("wakeBar").addEventListener("click", () => state.privacy ? togglePrivacy() : openSheet("quick"));
      $("toggleReport").addEventListener("click", toggleReportDetails);
      $("openQuick").addEventListener("click", () => openSheet("quick"));
      $("openLab").addEventListener("click", () => openSheet("lab"));
      let liveWs = null, liveAudioCtx = null, liveMicStream = null, liveMicNode = null, livePlayTime = 0, livePhase = "disconnected", liveSeq = 0, liveReplyText = "";
      function setLiveUi(phase) {
        livePhase = phase;
        const active = phase !== "disconnected" && phase !== "error";
        $("liveVoiceBtn").classList.toggle("live-active", active);
        $("liveVoiceLabel").textContent = phase === "speaking" ? "打断" : active ? "LIVE 中" : "LIVE 对话";
        state.speaking = phase === "speaking";
        state.expression = phase === "thinking" ? "thinking" : phase === "listening" ? "curious" : "neutral";
        renderFace();
      }
      function stopWebAudio() {
        livePlayTime = 0;
        if (liveAudioCtx) {
          try { void liveAudioCtx.close(); } catch {}
          liveAudioCtx = null;
        }
      }
      function playPcm24kBase64(b64, rate = 24000) {
        try {
          if (!liveAudioCtx) liveAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
          const bin = atob(b64);
          const samples = new Float32Array(Math.floor(bin.length / 2));
          for (let i = 0; i < samples.length; i++) {
            const lo = bin.charCodeAt(i * 2);
            const hi = bin.charCodeAt(i * 2 + 1);
            const s = (hi << 8) | lo;
            samples[i] = (s >= 0x8000 ? s - 0x10000 : s) / 32768;
          }
          const buf = liveAudioCtx.createBuffer(1, samples.length, rate);
          buf.getChannelData(0).set(samples);
          const src = liveAudioCtx.createBufferSource();
          src.buffer = buf;
          src.connect(liveAudioCtx.destination);
          const startAt = Math.max(liveAudioCtx.currentTime, livePlayTime);
          src.start(startAt);
          livePlayTime = startAt + buf.duration;
        } catch {}
      }
      async function startWebMic() {
        if (!navigator.mediaDevices?.getUserMedia || liveMicStream) return;
        try {
          liveMicStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
          const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
          const src = ctx.createMediaStreamSource(liveMicStream);
          const proc = ctx.createScriptProcessor(2048, 1, 1);
          proc.onaudioprocess = (ev) => {
            if (!liveWs || liveWs.readyState !== 1) return;
            const ch = ev.inputBuffer.getChannelData(0);
            const pcm = new Uint8Array(ch.length * 2);
            const view = new DataView(pcm.buffer);
            for (let i = 0; i < ch.length; i++) {
              const c = Math.max(-1, Math.min(1, ch[i]));
              view.setInt16(i * 2, c < 0 ? c * 32768 : c * 32767, true);
            }
            let bin = "";
            for (let i = 0; i < pcm.length; i++) bin += String.fromCharCode(pcm[i]);
            liveWs.send(JSON.stringify({ type: "audio_chunk", pcm_base64: btoa(bin), sample_rate: 16000, sequence: ++liveSeq }));
          };
          src.connect(proc);
          proc.connect(ctx.destination);
          liveMicNode = { ctx, proc };
        } catch {}
      }
      function stopLiveVoice() {
        if (liveMicNode) { try { liveMicNode.proc.disconnect(); void liveMicNode.ctx.close(); } catch {} liveMicNode = null; }
        if (liveMicStream) { liveMicStream.getTracks().forEach((t) => t.stop()); liveMicStream = null; }
        stopWebAudio();
        if (liveWs) { try { liveWs.send(JSON.stringify({ type: "session_close" })); liveWs.close(); } catch {} liveWs = null; }
        setLiveUi("disconnected");
      }
      async function ensureLiveVoice() {
        if (liveWs && liveWs.readyState === 1) return liveWs;
        setLiveUi("connecting");
        const ws = new WebSocket(location.origin.replace(/^http/i, "ws") + "/ws/voice");
        liveWs = ws;
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("语音连接超时")), 8000);
            ws.onopen = () => { clearTimeout(timer); resolve(); };
            ws.onerror = () => { clearTimeout(timer); reject(new Error("语音通道不可用")); };
          });
        } catch (err) {
          try { ws.close(); } catch {}
          liveWs = null;
          setLiveUi("disconnected");
          throw err;
        }
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data));
            if (msg.type === "state_change") {
              setLiveUi(msg.state === "speaking" ? "speaking" : msg.state === "thinking" ? "thinking" : "listening");
            } else if (msg.type === "transcript") {
              if (msg.role === "user") {
                liveReplyText = "";
                $("subtitle").hidden = false;
                $("subtitle").textContent = clean("你：" + msg.text);
              } else {
                const shown = msg.is_final ? msg.text : liveReplyText + msg.text;
                liveReplyText = msg.is_final ? "" : shown;
                $("subtitle").hidden = false;
                $("subtitle").textContent = clean(shown);
              }
            } else if (msg.type === "audio_chunk" && msg.pcm_base64) {
              setLiveUi("speaking");
              playPcm24kBase64(msg.pcm_base64, msg.sample_rate || 24000);
            } else if (msg.type === "agent_status") {
              if (msg.task_id) $("stopAgentBtn").hidden = msg.phase === "done" || msg.phase === "error";
              if (msg.interaction && msg.task_id) {
                const interaction = msg.interaction;
                let answer;
                if (interaction.kind === "approval") {
                  answer = { outcome: window.confirm("允许执行这一步？\\n" + String(interaction.details.command || interaction.details.toolName || "请求的操作") + "\\n" + String(interaction.details.reason || "")) ? "allowed-once" : "rejected" };
                } else {
                  const answers = [];
                  let cancelled = false;
                  for (const question of interaction.details.questions || []) {
                    const labels = (question.options || []).map(option => option.label);
                    const value = window.prompt(question.question + (question.detail ? "\\n" + question.detail : "") + (labels.length ? "\\n选项：" + labels.join(" / ") : ""));
                    if (value === null) { cancelled = true; break; }
                    answers.push({ id: question.id, selected: labels.includes(value) ? [value] : [], ...(labels.includes(value) ? {} : { custom: value }) });
                  }
                  answer = cancelled ? { cancelled: true } : { answers };
                }
                ws.send(JSON.stringify({ type: "agent_response", task_id: msg.task_id, request_id: interaction.id, answer }));
              }
              if (msg.phase === "error") toast(msg.summary);
              if (msg.phase === "thinking" || msg.phase === "tool_start") {
                setLiveUi("thinking");
                $("subtitle").hidden = false;
                $("subtitle").textContent = clean("Agent · " + msg.summary);
              } else if (msg.phase === "tool_end" || msg.phase === "done") {
                toast(msg.summary);
                if (livePhase === "thinking") setLiveUi("listening");
                void refresh();
              }
            } else if (msg.type === "interrupted") {
              stopWebAudio();
              liveReplyText = "";
              setLiveUi("listening");
            }
          } catch {}
        };
        ws.onclose = () => { liveWs = null; stopLiveVoice(); };
        ws.send(JSON.stringify({ type: "unmute_commit" }));
        setLiveUi("listening");
        void startWebMic();
        return ws;
      }
      $("stopAgentBtn").addEventListener("click", () => {
        if (liveWs) liveWs.send(JSON.stringify({ type: "agent_cancel" }));
      });
      $("liveVoiceBtn").addEventListener("click", () => {
        if (state.privacy) return;
        if (livePhase === "speaking" && liveWs) {
          stopWebAudio();
          liveReplyText = "";
          liveWs.send(JSON.stringify({ type: "barge_in" }));
          setLiveUi("listening");
          toast("已打断播报，继续聆听");
          return;
        }
        if (liveWs) {
          stopLiveVoice();
          $("subtitle").hidden = true;
          toast("实时语音已关闭");
          return;
        }
        void perform(async () => {
          await ensureLiveVoice();
          toast("LIVE 全双工对话已开启");
        });
      });
      $("openAskBtn").addEventListener("click", () => {
        if (state.privacy) return;
        $("askBar").hidden = !$("askBar").hidden;
        if (!$("askBar").hidden) $("askInput").focus();
      });
      $("askBar").addEventListener("submit", (e) => {
        e.preventDefault();
        const text = $("askInput").value.trim();
        if (!text || state.privacy) return;
        $("askInput").value = "";
        $("askBar").hidden = true;
        void perform(async () => {
          const ws = await ensureLiveVoice();
          liveReplyText = "";
          $("subtitle").hidden = false;
          $("subtitle").textContent = clean("你：" + text);
          ws.send(JSON.stringify({ type: "text_input", text }));
        });
      });
      $("closeSheet").addEventListener("click", () => closeSheet());
      $("sheetBackdrop").addEventListener("click", (e) => {
        if (e.target === $("sheetBackdrop")) closeSheet();
      });
      $("sheet").addEventListener("pointerdown", (e) => {
        armDrawer();
        if (e.pointerType !== "touch" && e.button === 0) startSheetDrag(e, e.target, e.pointerId);
      });
      $("sheet").addEventListener("keydown", armDrawer);
      $("sheet").addEventListener("pointermove", () => { if (!sheetDrag?.active) armDrawer(); });
      document.addEventListener("pointermove", (e) => moveSheetDrag(e, e, e.pointerId));
      document.addEventListener("pointerup", (e) => finishSheetDrag(false, e.pointerId));
      document.addEventListener("pointercancel", (e) => finishSheetDrag(true, e.pointerId));
      $("sheet").addEventListener("touchstart", (e) => {
        armDrawer();
        if (e.touches.length === 1) startSheetDrag(e.touches[0], e.target, "touch");
        else finishSheetDrag(true, "touch");
      }, { passive: true });
      $("sheet").addEventListener("touchmove", (e) => {
        if (e.touches.length === 1) moveSheetDrag(e.touches[0], e, "touch");
      }, { passive: false });
      document.addEventListener("touchend", () => finishSheetDrag(false, "touch"));
      document.addEventListener("touchcancel", () => finishSheetDrag(true, "touch"));
      $("sheet").addEventListener("click", (e) => {
        if (Date.now() < suppressSheetClickUntil) { e.preventDefault(); e.stopPropagation(); }
      }, true);
      document.addEventListener("pointerdown", (e) => { if (e.target.closest("[data-brightness]")) draggingSlider = true; });
      document.addEventListener("touchstart", (e) => { if (e.target.closest("[data-brightness]")) draggingSlider = true; }, { passive: true });
      document.addEventListener("pointerup", () => { draggingSlider = false; });
      document.addEventListener("pointercancel", () => { draggingSlider = false; });
      document.addEventListener("touchend", () => { draggingSlider = false; });
      document.addEventListener("touchcancel", () => { draggingSlider = false; });
      document.addEventListener("keydown", (e) => {
        if (!state.sheet) return;
        if (e.key === "Escape") {
          e.preventDefault();
          closeSheet();
        }
        if (e.key === "Tab") {
          const focusable = [...$("sheet").querySelectorAll("button:not(:disabled),input")];
          const first = focusable[0],
            last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      });
      document.addEventListener("click", (e) => {
        const gazeTarget = e.target.closest("[data-gaze], [data-claim]");
        if (gazeTarget) gaze(gazeTarget);
        const button = e.target.closest("button");
        if (!button) return;
        gaze(button);
        if (button.dataset.space) switchSpace(button.dataset.space);
        if (button.dataset.open) openSheet(button.dataset.open);
        if (button.dataset.quick) {
          const action = button.dataset.quick;
          if (action === "lab") openSheet("lab");
          else if (action === "privacy") togglePrivacy();
          else switchSpace(action);
        }
        if (button.dataset.sim) void perform(() => simulate(button.dataset.sim));
        if (button.dataset.claim) {
          state.selected = button.dataset.claim;
          renderMemories();
          if (window.matchMedia("(max-width: 720px)").matches) setMemoryPane("inspector", true);
        }
        if (button.dataset.memoryPane) setMemoryPane(button.dataset.memoryPane, true);
        if (button.dataset.taskPane) setMobileTaskPane(button.dataset.taskPane, true);
        if (button.dataset.group) selectReportGroup(button.dataset.group);
        if (button.dataset.filter) {
          state.filter = button.dataset.filter;
          document
            .querySelectorAll("[data-filter]")
            .forEach((b) => b.setAttribute("aria-pressed", b === button ? "true" : "false"));
          renderMemories();
        }
        if (button.dataset.memory) void perform(() => memoryAction(button.dataset.memory));
        if (button.dataset.cancel) void cancelTask(button.dataset.cancel);
        if (button.dataset.approve)
          void perform(async () => {
            button.disabled = true;
            const data = await api(
              "/api/tasks/" + encodeURIComponent(button.dataset.approve) + "/approve",
              { grantId: button.dataset.grant, userAction: userAction() },
            );
            if (!data.success) throw new Error("授权未确认");
            state.taskEvents[button.dataset.approve] = data.event;
            toast("审批已记录 · " + (data.event?.state || "等待事件"));
            await refresh();
          });
        if (button.dataset.home)
          void perform(() =>
            homeCommand(
              button.dataset.home,
              button.dataset.service,
              button.dataset.kelvin ? { color_temp_kelvin: Number(button.dataset.kelvin) } : button.dataset.level ? { brightness: Math.round(Number(button.dataset.level) / 100 * 255) } : {},
            ),
          );
        if (button.dataset.provider)
          void perform(async () => {
            const type = button.dataset.provider;
            const data = await api("/api/" + type + "/providers/select", {
              kind: button.dataset.kind,
            });
            if (!data.success) throw new Error("切换未确认");
            toast("引擎选择已更新：" + data.active);
            await refresh();
          });
        if (button.dataset.revoke)
          void perform(async () => {
            const data = await api(
              "/api/home/rules/" + encodeURIComponent(button.dataset.revoke) + "/revoke",
              {},
            );
            if (!data.success) throw new Error("撤销未确认");
            toast("约定已撤销");
            await refresh();
          });
        if (button.dataset.confirmRule)
          void perform(async () => {
            const data = await api(
              "/api/home/rules/" + encodeURIComponent(button.dataset.confirmRule) + "/confirm",
              { userAction: userAction() },
            );
            if (!data.success) throw new Error("规则确认失败");
            toast("约定已确认");
            await refresh();
          });
      });
      document.addEventListener("submit", (e) => {
        if (e.target.id === "correctionForm") void correctMemory(e);
      });
      $("memorySearch").addEventListener("input", renderMemories);
      $("homeSearch").addEventListener("input", () => { state.homeLimit = 40; renderHome(); });
      $("homeMore").addEventListener("click", () => { state.homeLimit = (state.homeLimit || 40) + 40; renderHome(); });
      document.addEventListener("change", (e) => {
        draggingSlider = false;
        if (e.target.dataset.brightness)
          void perform(() =>
            homeCommand(e.target.dataset.brightness, Number(e.target.value) === 0 ? "turn_off" : "turn_on", Number(e.target.value) === 0 ? {} : {
              brightness: Math.round(Number(e.target.value) / 100 * 255),
            }),
          );
      });
      document.addEventListener("input", (e) => {
        if (e.target.dataset.brightness) {
          const output = e.target.parentElement.querySelector("output");
          if (output) output.textContent = e.target.value + "%";
          e.target.style.setProperty("--level", e.target.value + "%");
        }
      });
      $("refreshHome").addEventListener("click", () => void refresh());
      $("resolveHome").addEventListener(
        "click",
        () =>
          void perform(async () => {
            const data = await api("/api/home/resolve?q=" + encodeURIComponent("书房灯"));
            $("homeFeedback").textContent = clean(
              data.clarificationPrompt || data.entity?.friendly_name || "没有匹配设备",
            );
            toast($("homeFeedback").textContent);
          }),
      );
      $("runAcceptance").addEventListener("click", () => void perform(runAcceptance));
      $("motionStop").addEventListener("click", () =>
        stopLocal("本地演练已停止；Hub 已发出的仿真请求无法由此撤回"),
      );
      $("ambient").addEventListener("touchstart", startAmbientSwipe, { passive: true });
      $("ambient").addEventListener("touchend", finishAmbientSwipe, { passive: true });
      $("ambient").addEventListener("touchcancel", () => { touchY = null; }, { passive: true });
      document.addEventListener("pointermove", (e) => {
        if (state.space === "face" && !state.privacy) {
          document.documentElement.style.setProperty(
            "--gx",
            Math.max(-12, Math.min(12, (e.clientX / innerWidth - 0.5) * 24)) + "px",
          );
          document.documentElement.style.setProperty(
            "--gy",
            Math.max(-8, Math.min(8, (e.clientY / innerHeight - 0.5) * 16)) + "px",
          );
        }
      });
      document.addEventListener("focusin", (e) => {
        if (e.target.closest("[data-gaze]")) gaze(e.target);
      });
      refreshTimer = setInterval(() => void refresh(), 5000);
      blinkInterval = setInterval(() => {
        if (
          !document.hidden &&
          !state.privacy &&
          !matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          $("face").classList.add("blinking");
          blinkTimer = setTimeout(() => $("face").classList.remove("blinking"), 140);
        }
      }, 4700);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void refresh();
      });
      if (typeof window !== "undefined") {
        window.addEventListener("blur", () => {
          draggingSlider = false;
          if (sheetDrag) finishSheetDrag(true, sheetDrag.source);
        });
      }
      window.addEventListener("pagehide", () => {
        if (typeof stopLiveVoice === "function") stopLiveVoice();
        [refreshTimer, blinkInterval].forEach(clearInterval);
        [drawerTimer, toastTimer, expressionTimer, speechTimer, blinkTimer].forEach(clearTimeout);
      });
      renderFace();
      renderReport();
      void refresh();
    </script>
  </body>
</html>
`;
}
