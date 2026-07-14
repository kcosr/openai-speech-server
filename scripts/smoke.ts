const base = process.env.OPENAI_SPEECH_SERVER_URL ?? "http://192.168.50.72:6624"; const token = process.env.OPENAI_SPEECH_SERVER_TOKEN;
if (!token) throw new Error("OPENAI_SPEECH_SERVER_TOKEN is required");
const headers = { authorization: `Bearer ${token}` };
for (const path of ["/health/ready", "/v1/models", "/v1/audio/capabilities"]) {
  const response = await fetch(`${base}${path}`, { headers: path.startsWith("/health/") ? {} : headers });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  console.log(path, response.status, response.headers.get("x-request-id") ?? "no-request-id");
}
