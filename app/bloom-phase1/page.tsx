import { notFound, redirect } from "next/navigation";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";

// Compatibility for previous local test links; there is only one workspace.
export const dynamic = "force-dynamic";
export default function PhaseOneDemoRedirect() {
  if (!isPhaseOneSimulation()) notFound();
  redirect("/dashboard");
}
