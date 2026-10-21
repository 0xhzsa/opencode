export * as ConfigStorage from "./storage.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Storage")({
  sessions: Schema.DurationFromString.pipe(optional).annotate({
    description:
      'Delete sessions whose last activity is older than this duration, such as "30 days". Read from global config only. Unset keeps sessions forever',
  }),
}) {}
