import { SimulatedPsp, Whydunit } from "../src/index.ts";

const w = new Whydunit({
  psp: new SimulatedPsp(),           // swap for RazorpayPsp({ keyId, keySecret })
  costRatio: 40,                     // wrongful stop vs wrongful retry
  maxInterventions: 3,
});

const observations = await w.psp.fetchFailedDebits(new Date("2026-01-01"));
const attributions = await w.attribute(observations);
const plan = await w.plan(attributions);
const result = await w.execute(plan, observations);

console.log(`${attributions.length} attributed, ${result.psp_effects} interventions sent`);
