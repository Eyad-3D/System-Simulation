// Central icon registry — maps the `icon` keys used in the component
// library JSON to lucide-react components, with a safe fallback.
import {
  Anchor,
  BatteryCharging,
  Box,
  Circle,
  CircleDot,
  CloudSun,
  Equal,
  Fan,
  LoaderPinwheel,
  Minus,
  Plug,
  Route,
  SlidersHorizontal,
  Zap,
  type LucideIcon,
} from "lucide-react";

const REGISTRY: Record<string, LucideIcon> = {
  zap: Zap,
  "circle-dot": CircleDot,
  plug: Plug,
  "battery-charging": BatteryCharging,
  fan: Fan,
  "sliders-horizontal": SlidersHorizontal,
  "loader-pinwheel": LoaderPinwheel,
  circle: Circle,
  minus: Minus,
  equal: Equal,
  route: Route,
  anchor: Anchor,
  "cloud-sun": CloudSun,
  box: Box,
};

export function componentIcon(key: string): LucideIcon {
  return REGISTRY[key] ?? Box;
}
