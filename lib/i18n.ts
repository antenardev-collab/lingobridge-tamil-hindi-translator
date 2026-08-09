import type { Side } from "./types";

/**
 * Every user-facing string in Tamil, Hindi, and English (Hard rules).
 * Slice 1 has no locale switcher — each side shows its own script, and the
 * permission-denial banner shows all three languages stacked.
 */

export const strings = {
  // Section headings, in each side's own script.
  heading: {
    ta: "தமிழ்",
    hi: "हिन्दी",
  },
  // Hold-to-talk button label, idle state, in each side's own script.
  holdToTalk: {
    ta: "பேச அழுத்திப் பிடிக்கவும்",
    hi: "बोलने के लिए दबाकर रखें",
  },
  // Button label while recording, in each side's own script.
  recording: {
    ta: "பதிவு செய்கிறது…",
    hi: "रिकॉर्ड हो रहा है…",
  },
  // Empty-state hint shown before any turn is captured, per side.
  noTurnsYet: {
    ta: "இன்னும் எதுவும் பதிவாகவில்லை",
    hi: "अभी तक कुछ रिकॉर्ड नहीं हुआ",
  },
} as const;

/**
 * Mic permission / capture failure message — shown in all three languages at
 * once so whoever is holding the phone can read at least one.
 */
export const micErrorMessages = {
  denied: {
    ta: "மைக்ரோஃபோன் அனுமதி மறுக்கப்பட்டது. உலாவி அமைப்புகளில் அனுமதி வழங்கவும்.",
    hi: "माइक्रोफ़ोन की अनुमति अस्वीकृत। ब्राउज़र सेटिंग्स में अनुमति दें।",
    en: "Microphone permission denied. Please allow it in your browser settings.",
  },
  unavailable: {
    ta: "மைக்ரோஃபோனைப் பயன்படுத்த முடியவில்லை. சாதனத்தைச் சரிபார்க்கவும்.",
    hi: "माइक्रोफ़ोन का उपयोग नहीं हो सका। कृपया अपना डिवाइस जाँचें।",
    en: "Could not access the microphone. Please check your device.",
  },
} as const;

export type MicErrorKind = keyof typeof micErrorMessages;

/** Convenience: pull a per-side string out of the two-language maps above. */
export function forSide(
  map: { ta: string; hi: string },
  side: Side,
): string {
  return map[side];
}
