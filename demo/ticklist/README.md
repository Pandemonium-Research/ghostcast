# ticklist

A team task list with a web app and a command line, sharing one JSON file. It is the project
filmed for the video at the top of [ghostcast's README](../../README.md); its plan is in
[`.ghostcast/`](.ghostcast).

```bash
cp tasks.seed.json tasks.json
npm start                    # the web app on http://127.0.0.1:3000/
bin/ticklist done 2          # the command line
```

To film it (editor beats need `ghostcast vscode --accept-server-license-terms` running, after
reading the VS Code Server license):

```bash
cd demo/ticklist
ghostcast next               # says what to do at each step: rehearse, approve, shoot, check
```

Shoots run in a disposable copy, so this folder never changes.
