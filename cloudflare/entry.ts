import app from "vinext/server/fetch-handler";
import type { DurableObjectNamespace, DurableObjectState, Request, Response } from "@cloudflare/workers-types";

type HeimdallEnv = {
  HEIMDALL: DurableObjectNamespace;
  [key: string]: unknown;
};

export class HeimdallDO {
  constructor(private state: DurableObjectState, private env: HeimdallEnv) {}

  fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.state);
  }
}

const worker = {
  fetch(request: Request, env: HeimdallEnv): Promise<Response> {
    // ponytail: one DO serializes dynamic requests; shard only if measured traffic requires it.
    return env.HEIMDALL.get(env.HEIMDALL.idFromName("primary")).fetch(request);
  },
};

export default worker;
