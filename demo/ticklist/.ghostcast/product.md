# Product questionnaire

## What it is

ticklist: a team task list. People add tasks in its web app and finish them from its command
line; both read and write one JSON file, `tasks.json`, one task per line.

## How to run it

`node server.js` serves the web app on `PORT` (3000 without it); `bin/ticklist` is the command
line (`ticklist done <id>`).

## Seed data

`cp tasks.seed.json tasks.json`: three tasks for a release week, one already done.

## Signing in

none needed.

## Flows worth showing

- Add a task in the web app: it appears at the end of the list with its number.
- Finish a task from the terminal: `ticklist done <id>` prints the list with it ticked.
- Open `tasks.json`: each task is one line, with its `done` flag.

## Off limits

none needed: it is a local app with made-up data.
