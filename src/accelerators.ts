// Curated accelerator list tracked on the vast.ai GPU rental market.
//
// `name` must match vast.ai's `gpu_name` EXACTLY as the API returns it — the
// bundles filter `{"gpu_name":{"eq":...}}` is a literal string match, and the
// values use spaces, not underscores ("H100 SXM", not "H100_SXM"). A wrong
// spelling silently yields zero offers rather than an error, so any addition
// here should be checked against a live query first.
//
// `tier` groups the list for the frontend: "flagship" is the current training
// generation the user cares most about (B200/B300), "datacenter" the previous
// generations still carrying most inference, "prosumer" the consumer cards that
// set the price floor for small-scale serving.

export type AcceleratorTier = "flagship" | "datacenter" | "prosumer";

export interface Accelerator {
  /** Exact vast.ai gpu_name. */
  name: string;
  /** Display label for the UI. */
  label: string;
  tier: AcceleratorTier;
  /** Approximate on-board memory in GB, for context in the UI. */
  vramGb: number;
}

export const ACCELERATORS: Accelerator[] = [
  { name: "B300", label: "B300", tier: "flagship", vramGb: 288 },
  { name: "B200", label: "B200", tier: "flagship", vramGb: 180 },
  { name: "H200 NVL", label: "H200 NVL", tier: "datacenter", vramGb: 141 },
  { name: "H200", label: "H200", tier: "datacenter", vramGb: 141 },
  { name: "H100 SXM", label: "H100 SXM", tier: "datacenter", vramGb: 80 },
  { name: "H100 NVL", label: "H100 NVL", tier: "datacenter", vramGb: 94 },
  { name: "H100 PCIE", label: "H100 PCIe", tier: "datacenter", vramGb: 80 },
  { name: "A100 SXM4", label: "A100 SXM4", tier: "datacenter", vramGb: 80 },
  { name: "A100 PCIE", label: "A100 PCIe", tier: "datacenter", vramGb: 80 },
  { name: "L40S", label: "L40S", tier: "datacenter", vramGb: 48 },
  { name: "RTX PRO 6000 S", label: "RTX PRO 6000 SE", tier: "prosumer", vramGb: 96 },
  { name: "RTX PRO 6000 WS", label: "RTX PRO 6000 WS", tier: "prosumer", vramGb: 96 },
  { name: "RTX 5090", label: "RTX 5090", tier: "prosumer", vramGb: 32 },
  { name: "RTX 4090", label: "RTX 4090", tier: "prosumer", vramGb: 24 },
  { name: "RTX 3090", label: "RTX 3090", tier: "prosumer", vramGb: 24 },
  { name: "Tesla T4", label: "Tesla T4", tier: "prosumer", vramGb: 16 },
];

export const ACCELERATOR_NAMES: string[] = ACCELERATORS.map((a) => a.name);

export function findAccelerator(name: string): Accelerator | undefined {
  return ACCELERATORS.find((a) => a.name === name);
}
