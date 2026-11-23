// =============================================================================
// StockStudio Pro — Transparent Production Pages Function Gateway
//
// Forwards all incoming HTTPS requests directly to the bound production Worker
// (`stockstudio-pro-license-api-prod`) via Cloudflare Service Binding.
// Never parses, logs, or stores request bodies, license keys, or credentials.
// =============================================================================

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  LICENSE_API: ServiceBinding;
}

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  return context.env.LICENSE_API.fetch(context.request);
};
