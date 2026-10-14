# Club Votes

A place for your club to decide things together. Anyone can post a
question the club needs to decide — where to meet, what to do next —
give it two or more choices, and everyone votes by tapping a choice.
One vote per person, changeable until the person who asked closes the
vote. Comments run under each question, so the talk happens next to the
decision.

## How it works

- **Ask the club** — the button at the top opens a short form: a
  question and at least two choices. Whoever posted it can delete their
  question or **Close vote** when it is time to decide.
- **Voting** — tap a choice to vote, tap another to change. Your choice
  is marked with a check. Results (chalk tally marks per choice) stay
  hidden until you vote yourself or the vote is closed; before that you
  only see how many people have voted. Closing turns the winning choice
  into a "Decided" line — or notes a tie, or that nobody voted.
- **Comments** — every question has its own thread. You can delete your
  own comments; other people's carry a **Report** button (reports are
  recorded for admins and hide nothing).
- **Guests** — people not signed in to Homeroom can read everything but
  are shown a sign-in hint wherever voting or commenting would be.

Open questions list first, newest first, then the decided ones.

## Staging demo

On staging, `/?demo=1` fills the board with made-up questions and people
("Staging demo: made-up questions and people" shows under the header),
including one question owned by the viewer so voting and closing can be
tried. The plain route never shows the demo rows. Demo data is seeded
into the same tables, marked `is_demo`, and stays idempotent across
reloads.

## Building

```
npm ci --include=dev
npm run build   # compiles styles/tailwind-input.css to public/tailwind.css
node server.js
```

The server verifies the platform-issued token on every request and
stores everything in the app's own Postgres database. To change this
app, ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon
in the header, then **Suggest an improvement**.
