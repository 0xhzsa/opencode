import { Schema } from "effect"
import { Extension, Store } from "../sdk"
import details from "../details/i18n/en"
import en from "./i18n/en"

type Messages = { readonly default: Record<string, string> }

// The tab renders the details panel's MCP, plugin, skill and LSP rows, which read that extension's strings.
const withDetails = (own: () => Promise<Messages>, shared: () => Promise<Messages>) => () =>
  Promise.all([own(), shared()]).then(([messages, fallback]) => ({
    default: { ...fallback.default, ...messages.default },
  }))

export default Extension.define({
  id: "context",
  legacy: ["usage"],
  stores: {
    // The tab's expanded sections, kept across sessions and restarts.
    sections: Store.global(Schema.Struct({ open: Schema.Array(Schema.String) }), { open: ["context", "mcp"] }),
  },
  i18n: {
    en: { ...details, ...en },
    am: withDetails(
      () => import("./i18n/am"),
      () => import("../details/i18n/am"),
    ),
    ar: withDetails(
      () => import("./i18n/ar"),
      () => import("../details/i18n/ar"),
    ),
    az: withDetails(
      () => import("./i18n/az"),
      () => import("../details/i18n/az"),
    ),
    bg: withDetails(
      () => import("./i18n/bg"),
      () => import("../details/i18n/bg"),
    ),
    bn: withDetails(
      () => import("./i18n/bn"),
      () => import("../details/i18n/bn"),
    ),
    br: withDetails(
      () => import("./i18n/br"),
      () => import("../details/i18n/br"),
    ),
    bs: withDetails(
      () => import("./i18n/bs"),
      () => import("../details/i18n/bs"),
    ),
    ca: withDetails(
      () => import("./i18n/ca"),
      () => import("../details/i18n/ca"),
    ),
    cs: withDetails(
      () => import("./i18n/cs"),
      () => import("../details/i18n/cs"),
    ),
    da: withDetails(
      () => import("./i18n/da"),
      () => import("../details/i18n/da"),
    ),
    de: withDetails(
      () => import("./i18n/de"),
      () => import("../details/i18n/de"),
    ),
    dv: withDetails(
      () => import("./i18n/dv"),
      () => import("../details/i18n/dv"),
    ),
    dz: withDetails(
      () => import("./i18n/dz"),
      () => import("../details/i18n/dz"),
    ),
    el: withDetails(
      () => import("./i18n/el"),
      () => import("../details/i18n/el"),
    ),
    es: withDetails(
      () => import("./i18n/es"),
      () => import("../details/i18n/es"),
    ),
    et: withDetails(
      () => import("./i18n/et"),
      () => import("../details/i18n/et"),
    ),
    fa: withDetails(
      () => import("./i18n/fa"),
      () => import("../details/i18n/fa"),
    ),
    fi: withDetails(
      () => import("./i18n/fi"),
      () => import("../details/i18n/fi"),
    ),
    fo: withDetails(
      () => import("./i18n/fo"),
      () => import("../details/i18n/fo"),
    ),
    fr: withDetails(
      () => import("./i18n/fr"),
      () => import("../details/i18n/fr"),
    ),
    he: withDetails(
      () => import("./i18n/he"),
      () => import("../details/i18n/he"),
    ),
    hi: withDetails(
      () => import("./i18n/hi"),
      () => import("../details/i18n/hi"),
    ),
    hr: withDetails(
      () => import("./i18n/hr"),
      () => import("../details/i18n/hr"),
    ),
    hu: withDetails(
      () => import("./i18n/hu"),
      () => import("../details/i18n/hu"),
    ),
    hy: withDetails(
      () => import("./i18n/hy"),
      () => import("../details/i18n/hy"),
    ),
    id: withDetails(
      () => import("./i18n/id"),
      () => import("../details/i18n/id"),
    ),
    is: withDetails(
      () => import("./i18n/is"),
      () => import("../details/i18n/is"),
    ),
    it: withDetails(
      () => import("./i18n/it"),
      () => import("../details/i18n/it"),
    ),
    ja: withDetails(
      () => import("./i18n/ja"),
      () => import("../details/i18n/ja"),
    ),
    ka: withDetails(
      () => import("./i18n/ka"),
      () => import("../details/i18n/ka"),
    ),
    km: withDetails(
      () => import("./i18n/km"),
      () => import("../details/i18n/km"),
    ),
    ko: withDetails(
      () => import("./i18n/ko"),
      () => import("../details/i18n/ko"),
    ),
    lo: withDetails(
      () => import("./i18n/lo"),
      () => import("../details/i18n/lo"),
    ),
    lt: withDetails(
      () => import("./i18n/lt"),
      () => import("../details/i18n/lt"),
    ),
    lv: withDetails(
      () => import("./i18n/lv"),
      () => import("../details/i18n/lv"),
    ),
    mk: withDetails(
      () => import("./i18n/mk"),
      () => import("../details/i18n/mk"),
    ),
    mn: withDetails(
      () => import("./i18n/mn"),
      () => import("../details/i18n/mn"),
    ),
    ms: withDetails(
      () => import("./i18n/ms"),
      () => import("../details/i18n/ms"),
    ),
    my: withDetails(
      () => import("./i18n/my"),
      () => import("../details/i18n/my"),
    ),
    ne: withDetails(
      () => import("./i18n/ne"),
      () => import("../details/i18n/ne"),
    ),
    nl: withDetails(
      () => import("./i18n/nl"),
      () => import("../details/i18n/nl"),
    ),
    no: withDetails(
      () => import("./i18n/no"),
      () => import("../details/i18n/no"),
    ),
    pa: withDetails(
      () => import("./i18n/pa"),
      () => import("../details/i18n/pa"),
    ),
    pl: withDetails(
      () => import("./i18n/pl"),
      () => import("../details/i18n/pl"),
    ),
    ro: withDetails(
      () => import("./i18n/ro"),
      () => import("../details/i18n/ro"),
    ),
    ru: withDetails(
      () => import("./i18n/ru"),
      () => import("../details/i18n/ru"),
    ),
    si: withDetails(
      () => import("./i18n/si"),
      () => import("../details/i18n/si"),
    ),
    sk: withDetails(
      () => import("./i18n/sk"),
      () => import("../details/i18n/sk"),
    ),
    sl: withDetails(
      () => import("./i18n/sl"),
      () => import("../details/i18n/sl"),
    ),
    sq: withDetails(
      () => import("./i18n/sq"),
      () => import("../details/i18n/sq"),
    ),
    sr: withDetails(
      () => import("./i18n/sr"),
      () => import("../details/i18n/sr"),
    ),
    sv: withDetails(
      () => import("./i18n/sv"),
      () => import("../details/i18n/sv"),
    ),
    tg: withDetails(
      () => import("./i18n/tg"),
      () => import("../details/i18n/tg"),
    ),
    th: withDetails(
      () => import("./i18n/th"),
      () => import("../details/i18n/th"),
    ),
    tk: withDetails(
      () => import("./i18n/tk"),
      () => import("../details/i18n/tk"),
    ),
    tr: withDetails(
      () => import("./i18n/tr"),
      () => import("../details/i18n/tr"),
    ),
    uk: withDetails(
      () => import("./i18n/uk"),
      () => import("../details/i18n/uk"),
    ),
    ur: withDetails(
      () => import("./i18n/ur"),
      () => import("../details/i18n/ur"),
    ),
    uz: withDetails(
      () => import("./i18n/uz"),
      () => import("../details/i18n/uz"),
    ),
    vi: withDetails(
      () => import("./i18n/vi"),
      () => import("../details/i18n/vi"),
    ),
    zh: withDetails(
      () => import("./i18n/zh"),
      () => import("../details/i18n/zh"),
    ),
    zht: withDetails(
      () => import("./i18n/zht"),
      () => import("../details/i18n/zht"),
    ),
  },
})
