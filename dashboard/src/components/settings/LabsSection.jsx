import React from "react";
import { SectionCard, SettingsRow, ToggleSwitch } from "./Controls.jsx";
import { copy } from "../../lib/copy";
import { useQualityPerDollarPref } from "../../hooks/use-quality-per-dollar-pref.js";

// Experimental / opt-in features. See GitHub issue 229.
export function LabsSection() {
  const { enabled, toggle } = useQualityPerDollarPref();

  return (
    <SectionCard title={copy("settings.section.labs")}>
      <SettingsRow
        label={copy("settings.labs.qpd.label")}
        hint={copy("settings.labs.qpd.hint")}
        control={
          <ToggleSwitch
            checked={enabled}
            onChange={toggle}
            ariaLabel={copy("settings.labs.qpd.aria")}
          />
        }
      />
    </SectionCard>
  );
}
