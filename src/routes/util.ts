import type { BusinessContext } from "../agents/onboarding";
import { buildPrompt } from "../agents/prompt";
import { type Business, type HqConfig, findBusiness, getConfig } from "../config/store";
import { loadTaskPageDetails } from "../dispatch/run";
import type { DispatchJob } from "../dispatch/types";
import type { Env } from "../env";
import { HttpError, errorMessage } from "../lib/errors";
import { createNotion } from "../notion/client";
import { emptyHqContext, getHqContext } from "../notion/hq";

/** Resolves ?business= / body.business (id, name or domain); empty means the default business. */
export async function businessFromRef(env: Env, ref: string | null | undefined): Promise<Business> {
  const config = await getConfig(env);
  const business = findBusiness(config, ref ?? null);
  if (!business) {
    throw new HttpError(422, `Unknown business "${ref}"`, { known: config.businesses.map((b) => b.id) });
  }
  return business;
}


/** HQ context for each business (all, or just `only`); a failing business doesn't sink the rest. */
export async function loadContexts(env: Env, config: HqConfig, only?: Business): Promise<BusinessContext[]> {
  const list = only ? [only] : config.businesses;
  return Promise.all(
    list.map(async (business): Promise<BusinessContext> => {
      if (!business.hqPageId) return { business, context: null, error: "no Notion HQ page connected yet" };
      try {
        return { business, context: (await getHqContext(env, business)).context };
      } catch (err) {
        return { business, context: null, error: errorMessage(err) };
      }
    }),
  );
}

/** The exact prompt the worker would use for a job — handed to external agents so they work the same way. */
export async function promptForJob(env: Env, job: DispatchJob): Promise<{ system: string; user: string }> {
  const business = await businessFromRef(env, job.business);
  const context = business.hqPageId ? (await getHqContext(env, business)).context : null;
  const details = { ...(job.details ?? {}) };
  if (job.taskPageId) {
    Object.assign(details, await loadTaskPageDetails(createNotion(env, business), job.taskPageId).catch(() => ({})));
  }
  const prompt = buildPrompt({
    owner: job.owner,
    task: job.task,
    kind: job.kind,
    business,
    context: context ?? emptyHqContext(business),
    requestedSections: job.contextSections,
    details,
  });
  return { system: prompt.system, user: prompt.user };
}
