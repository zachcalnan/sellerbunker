import type { Appearance } from "@clerk/types";

/**
 * Monochrome Clerk UI for sign-in / sign-up only (no brand green/teal).
 */
export const clerkAuthMonochromeAppearance: Appearance = {
  layout: {
    unsafe_disableDevelopmentModeWarnings: true,
  },
  variables: {
    colorPrimary: "#fafafa",
    colorTextOnPrimaryBackground: "#0a0a0a",
    colorSuccess: "#737373",
    colorDanger: "#a3a3a3",
    colorWarning: "#a3a3a3",
    colorNeutral: "#737373",
  },
  elements: {
    formButtonPrimary:
      "!bg-white !text-black hover:!bg-neutral-200 !shadow-none border-0",
    footerActionLink: "!text-neutral-300 hover:!text-white",
    identityPreviewText: "!text-neutral-300",
    formFieldLabel: "!text-neutral-300",
    headerTitle: "!text-white",
    headerSubtitle: "!text-neutral-400",
    socialButtonsBlockButton: "!border-neutral-600 !text-white",
  },
};
