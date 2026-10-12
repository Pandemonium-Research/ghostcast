# flagpole

Feature flags from your terminal, for Roastery, a small coffee shop. Flags live in
[`flags.yaml`](flags.yaml) in the repository; the `flagpole` command rolls a flag out in steps;
a dashboard shows each flag's reach and recent changes; the shop reads the flags for each visitor.

It is the project filmed for the video at the top of [ghostcast's README](../../README.md). Its
plan, storyboard and cards are in [`.ghostcast/`](.ghostcast).

```bash
npm start                              # dashboard on http://127.0.0.1:4000/, shop on /shop
bin/flagpole rollout new-checkout 50%  # roll a flag out
bin/flagpole list
```

To film it, start VS Code for the editor beat (`ghostcast vscode --accept-server-license-terms`,
after reading the VS Code Server license), then run `ghostcast next` here and follow it:
rehearse, approve, shoot, check, confirm. Shoots run in a disposable copy, so `flags.yaml` here
never changes.
