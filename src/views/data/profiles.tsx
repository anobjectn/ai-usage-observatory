import { ShieldCheck } from "lucide-react";
import { type ProfileCard, providerColor } from "./insights";

const providerOf = (id: string) => (id.includes("anthropic") ? "anthropic" : "codex");

export function AllowanceProfiles({ profiles }: { profiles: ProfileCard[] }) {
  return (
    <section className="data-section">
      <header className="data-section__head">
        <div>
          <span className="overline">SUBSCRIPTION ALLOWANCE</span>
          <h2>Did the included capacity get used?</h2>
        </div>
        <p className="allowance-profiles__intro">
          Graded per provider from locally observed quota history, never blended. The session facets
          below do not change these scores — they read the quota meter, not your sessions.
        </p>
      </header>
      <div className="profile-grid">
        {profiles.map((profile) => {
          const provider = providerOf(profile.id);
          return (
            <article className="profile-card" key={profile.id} style={{ ["--provider" as string]: providerColor(provider) }}>
              <div className="profile-card__top">
                <span className="profile-provider">
                  <ShieldCheck /> {provider === "anthropic" ? "Claude" : "Codex"}
                </span>
                <span className={`profile-band ${profile.band ?? "na"}`}>{profile.band ? profile.band.replace("-", " ") : "not graded"}</span>
              </div>
              <div className="profile-score">
                {profile.score ?? "—"}
                <span>/100 · {profile.confidence} confidence</span>
              </div>
              <h3>Allowance capture</h3>
              <p>{profile.explanation}</p>
              <dl>
                {profile.components.map((component) => (
                  <div key={component.id}>
                    <dt>
                      {component.label}
                      <small>{component.weight}% weight</small>
                    </dt>
                    <dd>
                      {component.normalized === null ? "N/A" : Math.round(component.normalized)}
                      {component.value !== null && <small>measured {Math.round(component.value)}</small>}
                    </dd>
                    {component.unavailableReason && <em>{component.unavailableReason}</em>}
                  </div>
                ))}
              </dl>
              <footer>rubric {profile.rubricVersion}</footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
