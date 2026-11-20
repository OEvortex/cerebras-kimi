"use client";

import dynamic from "@/shared/router/dynamic";
import type { CSSProperties } from "react";
import {
  CONTENT_FONT_SCALES,
  CONTENT_LINE_SPACING,
  type ContentFontScale,
  type ContentLineSpacing,
} from "@/lib/learning-display";


import type { CodeBlockThemeId } from "@/components/common/code-block-themes";
import { CODE_BLOCK_THEME_OPTIONS } from "@/components/common/code-block-themes";
import { Toggle } from "@/components/settings/Toggle";
import { useUiSettings } from "@/features/settings/store";
import { ThemePreviewCard } from "@/components/settings/ThemePreviewCard";
import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
  selectClass,
  selectOptionClass,
} from "@/components/settings/shared";

const CODE_BLOCK_PREVIEW_SNIPPET = `def fibonacci(n):
    """Generate the first n Fibonacci numbers."""
    a, b = 0, 1
    result = []
    for _ in range(n):
        result.append(a)
        a, b = b, a + b
    return result


# Build a deliberately long summary so the wrapping preference is easy to see
summary = f"First twenty Fibonacci values rendered with the selected syntax theme, line-number setting, and wrapping preference: {', '.join(str(value) for value in fibonacci(20))}"
print(summary)
`;

const RichCodeBlockPreview = dynamic(
  () => import("@/components/common/RichCodeBlock"),
  { ssr: false },
);

export default function AppearanceSettingsPage() {
  
  const {
    theme,
    contentFontScale,
    contentLineSpacing,
    updateContentFontScale,
    updateContentLineSpacing,
    resetLearningText,
    codeBlockTheme,
    codeBlockShowLineNumbers,
    codeBlockWrapLongLines,
    updateTheme,
    updateCodeBlockTheme,
    updateCodeBlockShowLineNumbers,
    updateCodeBlockWrapLongLines,
  } = useUiSettings();

  // All code-block values come straight from the settings context (backed by
  // AppShellContext, the single source of truth), so the toggles reflect the
  // current preference without any local mirror state.
  const handleShowLineNumbersChange = (next: boolean) => {
    void updateCodeBlockShowLineNumbers(next);
  };

  const handleWrapLongLinesChange = (next: boolean) => {
    void updateCodeBlockWrapLongLines(next);
  };

  return (
    <div data-tour="tour-appearance">
      <SettingsPageHeader
        title={"Appearance"}
        description={"Customize the visual theme, learning text, and code blocks. Apply changes using the bar below."}
      />

      <SettingSection
        title={"Theme"}
        description={"Pick the colour palette and interface style. Each tile previews the theme it applies."}
      >
        <div className="py-3.5">
          {/* Order is intentional: System (follow the OS; the default for
              a new browser) → Default (pure-white neutral; theme id "snow"
              kept for stored preferences) → warm-light Cream → warm-dark
              Dark → cool-dark Glass. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {(
              [
                { id: "system", label: "System" },
                { id: "snow", label: "Default" },
                { id: "light", label: "Cream" },
                { id: "dark", label: "Dark" },
                { id: "glass", label: "Glass" },
              ] as const
            ).map(({ id, label }) => (
              <ThemePreviewCard
                key={id}
                theme={id}
                label={label}
                selected={theme === id}
                onSelect={updateTheme}
              />
            ))}
          </div>
          <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--muted-foreground)]/80">
            {"System follows the device's light or dark appearance."}{" "}
            {"Default is a clean pure-white theme with a blue accent. Cream is warm and paper-like with a terracotta accent. Dark keeps Cream's warmth on near-black. Glass adds translucent purple panels on a deep gradient."}
          </p>
        </div>
      </SettingSection>

      <SettingSection
        title={"Learning text"}
        description={"Adjust messages, lessons, and practice text. Your changes stay in this preview until you apply them. Immersive Reading has its own display controls."}
      >
        <SettingRow
          title={"Text size"}
          description={"Scale learning content while keeping navigation and controls the same size."}
          control={
            <select
              aria-label={"Learning text size"}
              value={contentFontScale}
              onChange={(event) =>
                void updateContentFontScale(
                  Number(event.target.value) as ContentFontScale,
                )
              }
              className={selectClass}
            >
              {CONTENT_FONT_SCALES.map((scale) => (
                <option key={scale} value={scale} className={selectOptionClass}>
                  {scale}%
                </option>
              ))}
            </select>
          }
        />
        <SettingRow
          title={"Line spacing"}
          description={"Choose the space between lines of learning text."}
          control={
            <select
              aria-label={"Learning line spacing"}
              value={contentLineSpacing}
              onChange={(event) =>
                void updateContentLineSpacing(
                  event.target.value as ContentLineSpacing,
                )
              }
              className={selectClass}
            >
              <option value="compact" className={selectOptionClass}>
                {"Compact"}
              </option>
              <option value="normal" className={selectOptionClass}>
                {"Normal"}
              </option>
              <option value="relaxed" className={selectOptionClass}>
                {"Relaxed"}
              </option>
            </select>
          }
        />
        <div className="border-t border-[var(--border)]/50 py-4">
          <div className="mb-3 text-[13.5px] font-medium">
            {"Learning text preview"}
          </div>
          <div
            data-testid="learning-text-preview"
            className="learning-text space-y-3 rounded-lg bg-[var(--muted)]/40 p-4 font-serif [overflow-wrap:anywhere]"
            style={
              {
                "--learning-text-base": "16px",
                "--learning-font-scale": contentFontScale / 100,
                "--learning-line-height":
                  CONTENT_LINE_SPACING[contentLineSpacing],
              } as CSSProperties
            }
          >
            <p lang="en">
              Learning starts with a question. Explore an idea, connect it to
              what you know, and explain it in your own words.
            </p>
            <p className="hidden" lang="zh">
              Learning starts with a question.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void resetLearningText()}
            className="mt-4 rounded-md border border-[var(--border)] px-3 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
          >
            {"Reset learning text"}
          </button>
        </div>
      </SettingSection>

      <SettingSection
        title={"Code blocks"}
        description={"Choose how code snippets look across the app after you apply changes."}
      >
        <div className="border-t border-[var(--border)]/50 py-3.5 first:border-t-0">
          <div className="text-[13.5px] font-medium text-[var(--foreground)]">
            {"Preview"}
          </div>
          <p className="mb-3 mt-1 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
            {"Updates live as you change the settings below."}
          </p>
          <RichCodeBlockPreview
            raw={CODE_BLOCK_PREVIEW_SNIPPET}
            lang="python"
          />
        </div>

        <SettingRow
          title={"Syntax theme"}
          description={"Select the Prism theme used for highlighted code blocks."}
          control={
            <select
              value={codeBlockTheme}
              onChange={(event) =>
                void updateCodeBlockTheme(
                  event.target.value as CodeBlockThemeId,
                )
              }
              className={`${selectClass} min-w-[220px] pr-8`}
            >
              {CODE_BLOCK_THEME_OPTIONS.map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  className={selectOptionClass}
                >
                  {option.label}
                </option>
              ))}
            </select>
          }
        />

        <SettingRow
          title={"Show line numbers"}
          description={"Display a gutter with line numbers beside each code block."}
          control={
            <Toggle
              checked={codeBlockShowLineNumbers}
              onChange={handleShowLineNumbersChange}
            />
          }
        />

        <SettingRow
          title={"Wrap long lines"}
          description={"Wrap long code lines instead of forcing horizontal scrolling."}
          control={
            <Toggle
              checked={codeBlockWrapLongLines}
              onChange={handleWrapLongLinesChange}
            />
          }
        />
      </SettingSection>
    </div>
  );
}
