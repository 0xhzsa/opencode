import { Schema } from "effect"

// A tour is a JSON file the dev server serves, named by `?tour=<url>`:
//
//   {
//     "coordinator": "ses_…",
//     "stops": [
//       { "id": "R-158", "title": "One search list", "look": "Sessions list first.", "palette": "desktop" },
//       {
//         "id": "D-10", "title": "Activity chip", "look": "Flip the chip above the composer.", "session": "ses_…",
//         "spotlight": "[data-component=session-activity-chips]",
//         "options": [{ "label": "1 · Today", "knobs": { "activity.chip": "today" } }, { "label": "3 · CSS orb", "knobs": { "activity.chip": "orb" } }]
//       }
//     ]
//   }
//
// A stop with options is a decision; any other stop is a review. On arrival a stop goes to at most one place (`route`,
// `session`, `settings` or `story`), sets its knobs, opens the palette with its text, then rings its spotlight.

/** A Knobs value: a choice's option, a toggle, a number, or a spring. */
const KnobValue = Schema.Union([
  Schema.String,
  Schema.Boolean,
  Schema.Finite,
  Schema.Struct({ duration: Schema.Finite, bounce: Schema.Finite }),
])

export type KnobValue = typeof KnobValue.Type

const Knobs = Schema.Record(Schema.String, KnobValue)

const Option = Schema.Struct({ label: Schema.String, knobs: Schema.optional(Knobs) })

export type TourOption = typeof Option.Type

const Stop = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** One line on what to look at. */
  look: Schema.optional(Schema.String),
  /** An app path; `:server` stands for the first healthy server's route segment. */
  route: Schema.optional(Schema.String),
  /** A session on the first healthy server, by id. */
  session: Schema.optional(Schema.String),
  /** A Settings page, such as `appearance`. */
  settings: Schema.optional(Schema.String),
  /** A components-lab story, by file name (`review-tour`) or by the lab's file key. */
  story: Schema.optional(Schema.String),
  knobs: Schema.optional(Knobs),
  /** Text to type into the ⌘K palette; an empty string just opens it. */
  palette: Schema.optional(Schema.String),
  /** A CSS selector to ring. */
  spotlight: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Option)),
})

export type TourStop = typeof Stop.Type

const Manifest = Schema.Struct({
  /** Where verdicts go, as queued prompts. Without one, verdicts stay in the tour. */
  coordinator: Schema.optional(Schema.String),
  stops: Schema.Array(Stop),
})

export type TourManifest = typeof Manifest.Type

export const TourVerdict = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ship") }),
  Schema.Struct({ kind: Schema.Literal("changes"), note: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("skip") }),
  Schema.Struct({ kind: Schema.Literal("pick"), option: Schema.String }),
])

export type TourVerdict = typeof TourVerdict.Type

/** Fetches and checks a tour. Only same-origin URLs load, so a link can't point the tour at another site. */
export async function loadManifest(url: string) {
  const target = new URL(url, location.href)

  if (target.origin !== location.origin) throw new Error(`The tour must be on ${location.origin}`)

  const response = await fetch(target, { cache: "no-store" })

  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)

  const manifest = await Schema.decodeUnknownPromise(Manifest)(await response.json())

  const crowded = manifest.stops.find(
    (stop) => [stop.route, stop.session, stop.settings, stop.story].filter((place) => place !== undefined).length > 1,
  )

  if (crowded) throw new Error(`${crowded.id} goes to more than one place`)

  return manifest
}

/** Every knob a stop may change, including those of its options. */
export function stopKnobs(stop: TourStop) {
  return [
    ...new Set([
      ...Object.keys(stop.knobs ?? {}),
      ...(stop.options ?? []).flatMap((option) => Object.keys(option.knobs ?? {})),
    ]),
  ]
}
