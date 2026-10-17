# PingRoom on-call router

Route a new incident to the PingRoom room covering the current UTC shift. Your application supplies the incident; a local roster selects the room. Saved receipts keep retries attached to their original recipient after roster changes.

Use this when several teams share duty and an existing system already knows that an incident occurred. This starter does not detect outages, page additional teams, or assign an individual responder.

## Try it offline

Requires Node.js 22 or newer. Create a repository with **Use this template**, clone it, then:

```sh
npm ci
npm run demo
npm test
```

The demo simulates two incidents across a shift boundary. Replaying the first incident sends nothing and retains the day team's receipt. It uses temporary state, reads no credentials, and makes no network requests. Tests also exercise the real pinned CLI against a local mock HTTP server.

Uses `@pingroom/cli` 0.12.0, pinned with a lockfile and a 14-day npm release-age policy. GitHub Actions runs the tests and demo on Node 22 and 24.

## Connect and define the roster

Install or open [PingRoom](https://pingroom.io/i), sign in, then:

```sh
cp config.example.json config.json
cp .env.example .env
npm run connect
```

Open the pairing link, select every room in your roster, and choose one selected private room as the robot’s delivery/home room. The router still uses the roster to choose each incident’s destination. Keep the process open until pairing finishes. Credentials are saved in the ignored `.pingroom/` directory; `PINGROOM_HOME` selects another connection directory.

Pairing again saves a new credential and revokes the old one. Other workflows sharing the old credential will lose access. Existing routing receipts are bound to that credential, so plan a receipt-preserving migration before pairing again.

For unattended use, set `PINGROOM_TOKEN` in `.env` or your process environment. An explicitly blank token fails instead of falling back to saved credentials. CI requires an explicit token. Existing environment values take precedence over `.env`, which is loaded from the project directory.

Edit `config.json` with current dates and the exact uppercase room codes from PingRoom:

```json
{
  "maxAgeSeconds": 900,
  "stateDirectory": ".routing",
  "shifts": [
    {
      "id": "day-2030-10-17",
      "startsAt": "2030-10-17T08:00:00.000Z",
      "endsAt": "2030-10-17T16:00:00.000Z",
      "room": "DAYTEAM12345"
    },
    {
      "id": "night-2030-10-17",
      "startsAt": "2030-10-17T16:00:00.000Z",
      "endsAt": "2030-10-18T08:00:00.000Z",
      "room": "NIGHTEAM1234"
    }
  ]
}
```

The example dates and room codes are placeholders. A shift includes its start and excludes its end. At exactly 16:00 UTC, the example selects the night team. Supply 1–256 shifts with unique IDs, positive durations, and no overlaps. Gaps are allowed, but an incident arriving during a gap fails without sending. Even overlapping shifts for the same room are rejected.

Use UTC timestamps with milliseconds and `Z`; local times and recurring schedules are unsupported. Export concrete UTC shifts from your scheduling system, including any daylight-saving adjustments, and replace the roster file atomically between runs. The router uses one validated snapshot for each run. `stateDirectory` is relative to this project or an absolute path on a persistent local filesystem.

Delivery always uses the roster's selected room. `PINGROOM_ROOM`, a saved home room, ambient webhook settings, and custom API settings do not choose its destination. The connected token still needs server permission to send to that room.

## Route an incident

Your producer writes a complete JSON file, such as `incidents/incident-1042.json`:

```json
{
  "id": "incident-1042",
  "occurredAt": "2030-10-17T15:59:00.000Z",
  "title": "New incident",
  "message": "A data import needs investigation.",
  "url": "https://example.com/incidents/1042"
}
```

Use the event's timestamp and link. Close the file before running:

```sh
npm run plan -- incidents/incident-1042.json
npm start -- incidents/incident-1042.json
npm run status
```

`plan` validates the incident and shows the current candidate without reading credentials, writing state, or contacting PingRoom. It does not reserve that route; the actual send rechecks the current time and any existing receipt. `npm start` sends at most one notification and exits. Call it from your incident handler after writing the file. No scheduler or webhook server is installed.

The current time selects the team, not `occurredAt`. New incidents must not be future-dated or older than `maxAgeSeconds` (1–3600, default example 900). An age exactly equal to the limit is accepted. Keep the host clock accurate. An old receipt can still be inspected or replayed after the incident becomes stale; replay sends nothing.

Input limits:

- `id`: 1–80 ASCII letters, digits, dots, underscores, colons, or hyphens, starting with a letter or digit. Reuse it for retries of the same incident.
- `title` and `message`: nonblank text without control characters, at most 40 and 120 UTF-16 units. Emoji can count as two units. Nothing is truncated.
- `url`: optional absolute HTTP(S) URL, at most 2048 characters, with no embedded credentials or whitespace. The router sends an **Open incident** button; it never fetches the link.
- Files: valid UTF-8 JSON, at most 8 KiB, with no extra fields. Configuration files are limited to 64 KiB.

Reusing the same ID and content returns its saved status. Changed content under that ID fails. Roster edits affect new incidents only; existing receipts retain their room, shift, content hash, and roster hash.

## Receipts and uncertain delivery

Before invoking the CLI, the router saves a `sending` receipt. It then checks that the incident is still fresh and the selected shift still covers the current time. If either changed, it records `blocked` and sends nothing. That ID remains blocked; after reviewing the current situation, submit a new incident ID if a notification is still needed.

A valid notification ID marks the receipt `sent`, meaning the server accepted the ping. It does not prove phone delivery or human acknowledgement. No urgent flag is used. A send already in flight can complete after a shift ends; the starter cannot make the local clock check and remote acceptance atomic.

A timeout, error, invalid response, or interrupted run leaves an uncertain outcome. It is displayed as `unknown` and is never automatically retried or routed to another room. Inspect the recorded PingRoom room, then resolve it explicitly:

```sh
npm run resolve -- incident-1042 confirmed
npm run resolve -- incident-1042 abandoned
```

Use `confirmed` after verifying the notification, or `abandoned` to retain the ID without retrying. Both send nothing. This avoids repeated attempts; delivery can still fail, and exactly-once delivery is not guaranteed.

`route` and `status` exit nonzero for `unknown` or `blocked` receipts. The CLI attempt has a 15-second timeout. Upstream response bodies, credentials, and incident bodies are not included in error messages. Plan output includes the supplied incident, so keep its console output private if the content is sensitive.

Keep `.routing/state.json` and back it up. Deleting it loses replay protection. The store binds to the connection token and production API; changing tokens requires an explicit migration that preserves receipts. There is no automatic migration. The store holds at most 10,000 receipts and 8 MiB, with no automatic eviction.

Use one store on one host. An exclusive lock prevents concurrent writers; separate hosts or temporary CI workers do not share that lock. After a crash, verify the old process has stopped before removing only `.routing/run.lock/`. Preserve the state file. State files use POSIX mode `0600` and directories use `0700`.

## Adapt it

Map your incident source into the JSON contract, and export your team's roster into explicit UTC intervals. Keep durable incident IDs and reuse the same state directory across invocations. The offline demo simulates sends; there are no deployment handlers or external ticket mutations.

For service health detection, see [uptime monitor](https://github.com/pingroom/starter-uptime-monitor). For future appointment reminders, see [calendar reminders](https://github.com/pingroom/starter-calendar-reminders). This starter chooses the current destination for an incident that already exists.

MIT licensed. See [LICENSE](LICENSE).
