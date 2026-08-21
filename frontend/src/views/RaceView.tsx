import { SectionHead } from "../components";
import { RacePanel } from "./RacePanel";

/**
 * The model race on its own tab: the same panel the Market page carries, with
 * the whole row height to itself, its own Paid/+Free switch, and a real
 * fullscreen mode for the wall-screen read.
 */
export function RaceView() {
  return (
    <>
      <SectionHead eyebrow="Head to head" title="The model race" />
      <RacePanel height={560} allowFullscreen />
      <div className="chart-note" style={{ marginTop: 10 }}>
        Est. spend is tokens × observed effective rates — an estimate, not billed revenue. Bars stack each lab's models
        into one additive bar (palest cap = the rest of that lab's top-50 field); lines follow the top ten models
        individually. The shaded band on daily views is the day still filling — shown, never extrapolated.
      </div>
    </>
  );
}
