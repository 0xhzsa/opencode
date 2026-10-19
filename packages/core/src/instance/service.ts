export * as Instance from "./service.js"
export type { Services } from "../instance.js"

import { Context, Effect, type LayerMap, Option, Scope } from "effect"
import type { Location } from "@opencode/schema/location"
import type { Session } from "@opencode/schema/session"
import { Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import type { Services, Error } from "../instance.js"

/** Selects Session capabilities; implementations own caching and lifetime. */
export interface Interface {
  readonly provide: (
    session: Session.Info,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Error, Exclude<R, Services>>
  readonly provideIfLoaded: (
    session: Session.Info,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, Exclude<R, Services>>
}

export function provideContextEffectOption<K, E0>(
  get: (key: K) => Effect.Effect<Option.Option<Context.Context<Services>>, E0, Scope.Scope>,
  key: K,
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Option.Option<A>, E, Exclude<R, Services>> =>
    Effect.scopedWith((scope) =>
      Effect.gen(function* () {
        const context = yield* get(key).pipe(Scope.provide(scope), Effect.option, Effect.map(Option.flatten))
        if (Option.isNone(context)) return Option.none()
        return Option.some(yield* effect.pipe(Effect.provide(context.value)))
      }),
    )
}

export function fromLocations(
  locations: Pick<LayerMap.LayerMap<Location.Ref, Services, Error>, "get" | "contextEffectOption">,
): Interface {
  return Service.of({
    provide: (session) => Effect.provide(locations.get(session.location)),
    provideIfLoaded: (session) => provideContextEffectOption(locations.contextEffectOption, session.location),
  })
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instance") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)
