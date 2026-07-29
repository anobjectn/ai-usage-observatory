/** Release-stripped model name, e.g. `claude-opus-4-8` from `claude-opus-4-8-20260114`. Only a
 * trailing datestamp or `latest` is removed — a codename such as `gpt-5.6-sol` is part of the
 * family, since collapsing every `gpt-*` into one cohort would compare unlike models.
 *
 * Both the insights cohort maths and the Agent filter read families through this one function, so
 * a model can never be grouped one way in a chart and another way in a filter. */
export function familyOf(model: string) {
  return model.replace(/[-_ ](latest|\d{8})$/i, "") || "unknown";
}
