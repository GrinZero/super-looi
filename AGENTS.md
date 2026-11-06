1. pnpm first
2. 代码与 UI 设计及实现全部由主 agent 自己直接完成（不要调用 codex，codex 没有 UI 和审美），独立 review 交给自己的子 agent
3. 在执行长期任务时，先组织好 progress.md(由 step+checkbox 组成)，将进度更新到 progress.md，定期 commit
   1. 建议每一步都不断更新子 step，足够完善的 step
4. 每当有部分待解决的问题，记录到 todo.md，如果问题有阶段性结论，可以清理  todo.md 中的部分产物，落地到 docs/
5. 需要的环境变量在 .env
6. 推荐使用 IOS 模拟器，性能更好
7. 通过修改 app.json 或者注册插件的方式修改原生代码，不可以直接修改 expo prebuild 产物
