import type { ReactElement } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { LOOI_PALETTE as P } from "../theme.js";

interface ToggleSwitchProps {
  value: boolean;
  compact?: boolean;
  disabled?: boolean;
  pending?: boolean;
  label: string;
  onValueChange: (value: boolean) => void;
}

/** Controlled by device snapshots; tapping only requests an explicit target. */
export function ToggleSwitch({ value, disabled = false, pending = false, label, onValueChange, compact = false }: ToggleSwitchProps): ReactElement {
  return <Pressable
    accessibilityRole="switch"
    accessibilityLabel={label}
    accessibilityState={{ checked: value, disabled, busy: pending }}
    disabled={disabled}
    onPress={() => onValueChange(!value)}
    style={({ pressed }) => [styles.touchTarget, compact && styles.compactTouchTarget, disabled && styles.disabled, pressed && styles.pressed]}
  >
    <View style={[styles.track, compact && styles.compactTrack, value && styles.trackOn, pending && styles.trackPending]}>
      <View style={[styles.thumb, compact && styles.compactThumb, value && styles.thumbOn]} />
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  compactTouchTarget: { width: 48, minWidth: 48, minHeight: 44 }, compactTrack: { width: 44, height: 26, borderRadius: 13, padding: 2 }, compactThumb: { width: 20, height: 20, borderRadius: 10 },
  touchTarget: { width: 64, minWidth: 48, minHeight: 48, justifyContent: "center", alignItems: "center" },
  track: { width: 57, height: 32, padding: 3, borderRadius: 18, borderWidth: 1, borderColor: "rgba(117,147,164,0.38)", backgroundColor: "#14202B", justifyContent: "center" },
  trackOn: { borderColor: P.presenceCyan, experimental_backgroundImage: "linear-gradient(110deg, #084D7D 0%, #1688BE 100%)", boxShadow: "0 0 13px 0 rgba(40,213,255,0.27), inset 0 1px 5px 0 rgba(40,213,255,0.28)" },
  trackPending: { borderColor: P.amberWarning, boxShadow: "0 0 0 2px rgba(243,197,107,0.22)" },
  thumb: { width: 24, height: 24, borderRadius: 13, backgroundColor: "#8093A2", boxShadow: "0 2px 4px 0 rgba(0,0,0,0.4)" },
  thumbOn: { alignSelf: "flex-end", backgroundColor: "#F1FCFF", boxShadow: "0 0 9px 0 rgba(158,231,255,0.85)" },
  disabled: { opacity: 0.45 }, pressed: { opacity: 0.8, transform: [{ scale: 0.97 }] },
});
