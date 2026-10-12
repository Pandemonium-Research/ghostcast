# Product questionnaire

## What it is

flagpole: feature flags from the terminal, for a small coffee shop called Roastery. Flags live
in `flags.yaml` in the repository; the `flagpole` command rolls a flag out in steps; a dashboard
shows each flag's reach and recent changes; the shop reads the flags for each visitor.

## How to run it

`node server.js` serves the dashboard at `/` and the shop at `/shop` on `PORT` (4000 without
it). `bin/flagpole` is the command line (`flagpole rollout <flag> <percent>`).

## Seed data

none needed: `flags.yaml` as committed is the starting state (new-checkout at 0%).

## Signing in

none needed.

## Flows worth showing

- Open `flags.yaml`: new-checkout is at 0%.
- `flagpole rollout new-checkout 50%`: a progress bar in five steps, then "is live for 50% of users".
- The dashboard: new-checkout's card shows "Live · 50%", and the change appears under Activity.
- The shop (`/shop`): its visitor is in the rollout, so the "Express checkout" button appears.

## Off limits

none needed: a local app with made-up data.
