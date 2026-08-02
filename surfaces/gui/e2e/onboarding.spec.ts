import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("a clean install reaches its first Mission through a real Agent activation without a model key", async ({ page }) => {
  let workspace = "";
  let profile: Record<string, any> | null = null;
  let mainProfileId: string | null = null;
  let activated = false;

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/v1/settings") {
      return json({
        provider: "openai",
        model: "gpt-5.5",
        models: ["gpt-5.5"],
        has_key: false,
        model_ready: false,
        source: null,
        credential_source: null,
        onboarded: false,
        surfaces: { cowork: true, chat: false, code: true },
        scratch_base: "~/OpenWorker",
        secrets_path: "/tmp/secrets.json",
      });
    }
    if (path === "/v1/readiness") {
      const requestedWorkspace = url.searchParams.get("workspace") || workspace;
      const mainAgent = !requestedWorkspace
        ? "missing"
        : !mainProfileId
          ? "missing"
          : activated
            ? "ready"
            : "unverified";
      return json({
        model_ready: false,
        workspace: requestedWorkspace,
        workspace_valid: Boolean(requestedWorkspace),
        main_agent: mainAgent,
        main_profile: mainProfileId ? profile : null,
        can_create_mission: Boolean(requestedWorkspace) && mainAgent === "ready",
        next_action: !requestedWorkspace
          ? "choose_workspace"
          : mainAgent === "missing"
            ? "select_main_agent"
            : mainAgent === "unverified"
              ? "activate_main_agent"
              : "create_mission",
      });
    }
    if (path === "/v1/workspaces/pick" && method === "POST") {
      return json({ ok: true, path: "/tmp/first-mission" });
    }
    if (path === "/v1/workspaces/open" && method === "POST") {
      workspace = String(request.postDataJSON().path);
      return json({ ok: true, path: workspace, git_branch: "main" });
    }
    if (path === "/v1/agent-profiles/detect") return json({ results: { kimi: true } });
    if (path === "/v1/agent-profiles" && method === "GET") {
      return json({ profiles: profile ? [profile] : [] });
    }
    if (path === "/v1/agent-profiles" && method === "POST") {
      profile = { ...request.postDataJSON(), enabled: false, capabilities: {} };
      return json({ ok: true, profile });
    }
    if (/^\/v1\/agent-profiles\/[^/]+\/activate$/.test(path) && method === "POST") {
      activated = true;
      profile = {
        ...profile,
        enabled: true,
        capabilities: { agentInfo: { name: "fake-kimi", version: "1.0" } },
        capability_probe_fingerprint: "fake-kimi-fingerprint",
      };
      return json({ ok: true, profile, capabilities: profile.capabilities });
    }
    if (path === "/v1/agent-profiles/main" && method === "POST") {
      mainProfileId = String(request.postDataJSON().profile_id);
      return json({ ok: true, workspace, main_profile_id: mainProfileId });
    }
    if (path === "/v1/agent-profiles/main" && method === "GET") {
      return mainProfileId
        ? json({ workspace, main_profile_id: mainProfileId, profile })
        : json({ detail: "missing" }, 404);
    }
    return route.fallback();
  });

  await page.goto("/#/home");
  await page.getByRole("button", { name: "添加 workspace" }).click();
  await expect(page.getByRole("button", { name: "添加并激活 main Agent" })).toBeVisible();
  await page.getByRole("button", { name: "添加并激活 main Agent" }).click();
  await expect(page.getByTestId("home-next-action")).toBeHidden();
  expect(activated).toBe(true);
  await expect(page.getByText("配置快速对话模型")).toBeVisible();

  await page.getByRole("link", { name: "Missions" }).click();
  await page.getByRole("button", { name: "新建 Mission" }).first().click();
  const drawer = page.getByRole("dialog", { name: "新建 Mission" });
  await drawer.getByLabel("目标").fill("完成第一个 Mission");
  await drawer.getByRole("button", { name: "创建 Mission" }).click();
  await expect(page).toHaveURL(/#\/missions\/m-3$/);
  await expect(page.getByText("完成第一个 Mission", { exact: true }).first()).toBeVisible();
});
