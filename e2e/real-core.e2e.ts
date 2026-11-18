import { once } from "node:events";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { IPC_EVENTS } from "../src/shared/ipc-types";
import type { RpcSessionState } from "../src/shared/rpc-types";

test("real bundled sidecar persists settings and sessions and serves every stats route", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-real-core-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const addedProject = path.join(profile, "drawing-folder");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(addedProject)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			launchProfiles: {
				[project]: { noExtensions: true, noSkills: true, noRules: true },
			},
		}),
	);
	await fs.mkdir(path.join(project, "docs"));
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYSsAAAAASUVORK5CYII=",
		"base64",
	);
	await Promise.all([
		fs.writeFile(
			path.join(project, "docs", "README.md"),
			"# Local ARM audit\n\nRead ./notes.txt:2.\n\n![Diagram](diagram.png)\n",
		),
		fs.writeFile(path.join(project, "docs", "notes.txt"), "line one\nmarked line\n"),
		fs.writeFile(path.join(project, "docs", "diagram.png"), png),
	]);
	const attachmentName = "floor plan.ifc";
	const attachmentPath = path.join(project, attachmentName);
	await fs.writeFile(attachmentPath, "ISO-10303-21;");
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_BUNDLED_OMP: path.resolve("resources/omp"),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	Reflect.deleteProperty(env, "OMP_SIDECAR");
	const executablePath = process.env.OMP_GUI_TEST_APP;
	if (executablePath) Reflect.deleteProperty(env, "OMP_BUNDLED_OMP");
	const app = await electron.launch({
		...(executablePath ? { executablePath } : {}),
		args: [...(executablePath ? [] : [path.resolve("out/main/index.js")]), project, `--user-data-dir=${desktop}`],
		env,
	});
	const mainOutput: string[] = [];
	app.process().stdout?.on("data", (chunk: Buffer) => mainOutput.push(chunk.toString()));
	app.process().stderr?.on("data", (chunk: Buffer) => mainOutput.push(chunk.toString()));
	const page = await app.firstWindow();
	const errors: string[] = [];
	let imageRequests = 0;
	const imageServer = createServer((_request, response) => {
		imageRequests++;
		response.writeHead(200, { "Content-Type": "image/png" }).end(png);
	});
	page.on("pageerror", error => errors.push(error.message));
	const closeWelcome = async (title: string | RegExp, closeLabel: string | RegExp) => {
		const welcome = page.getByRole("dialog", { name: title, exact: true });
		await expect(welcome).toBeVisible();
		await welcome.getByRole("button", { name: closeLabel, exact: true }).click();
		await expect(welcome).toHaveCount(0);
	};
	try {
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const runtime = await app.evaluate(({ app }) => ({
			isPackaged: app.isPackaged,
			appPath: app.getAppPath(),
			executable: process.execPath,
			resourcesPath: process.resourcesPath,
			pid: process.pid,
			sidecarMode: process.env.OMP_SIDECAR ?? null,
			sidecarOverride: process.env.OMP_BUNDLED_OMP ?? null,
		}));
		if (executablePath) {
			expect(runtime.isPackaged).toBe(true);
			expect(runtime.sidecarOverride).toBeNull();
		}
		await closeWelcome("Welcome to omp", "Close");
		// The file input creates a real Electron File with a local path.
		await page.evaluate(() => {
			const input = document.createElement("input");
			input.type = "file";
			input.id = "drag-test-file";
			document.body.appendChild(input);
		});
		await page.locator("#drag-test-file").setInputFiles(attachmentPath);
		const composer = page.locator(".omp-composer-box textarea");
		await page.locator(".omp-transcript-scroll").evaluate(transcript => {
			const input = document.querySelector<HTMLInputElement>("#drag-test-file");
			const file = input?.files?.[0];
			if (!file) throw new Error("Missing drag fixture");
			const dataTransfer = new DataTransfer();
			dataTransfer.items.add(file);
			const acceptsDrop = !transcript.dispatchEvent(
				new DragEvent("dragover", { dataTransfer, bubbles: true, cancelable: true }),
			);
			if (!acceptsDrop) throw new Error("Transcript did not cancel the default file drop behavior");
			transcript.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
			input.remove();
		});
		await expect(composer).toHaveValue(`@"${attachmentName}" `);
		const removeAttachment = page.getByRole("button", { name: `Remove ${attachmentName}`, exact: true });
		await expect(removeAttachment).toBeVisible();
		await removeAttachment.click();
		await expect(composer).toHaveValue("");
		await expect(removeAttachment).toHaveCount(0);
		await page.getByRole("button", { name: "Review changes and files", exact: true }).click();
		await page.getByRole("button", { name: "Files", exact: true }).click();
		const tree = page.getByRole("tree");
		const preview = page.locator("[data-file-preview]");
		await tree.getByText("docs", { exact: true }).click();
		const readme = tree.getByText("README.md", { exact: true });
		await readme.click();
		await expect(preview.getByRole("heading", { name: "Local ARM audit" })).toBeVisible();
		await expect(tree).toBeVisible();
		const [treeBounds, previewBounds] = await Promise.all([tree.boundingBox(), preview.boundingBox()]);
		expect(previewBounds?.x ?? 0).toBeGreaterThan((treeBounds?.x ?? 0) + (treeBounds?.width ?? 0));
		const treeDivider = page.getByRole("separator", { name: "Resize file tree" });
		const originalTreeWidth = await treeDivider.getAttribute("aria-valuenow");
		await treeDivider.press("ArrowRight");
		await expect(treeDivider).not.toHaveAttribute("aria-valuenow", originalTreeWidth ?? "");
		await preview.getByRole("link", { name: "./notes.txt:2" }).click();
		await expect(preview).toContainText("marked line");
		await expect(tree.getByText("notes.txt", { exact: true })).toBeVisible();
		await readme.click();
		await preview.getByRole("button", { name: "Diagram", exact: true }).click();
		await expect(preview.locator('img[alt="diagram.png"]')).toBeVisible();
		await expect(tree).toBeVisible();
		const rightPanel = page.locator(".omp-inspector");
		const resizeHandle = page.getByRole("separator", { name: "Resize right panel" });
		const viewportWidth = await page.evaluate(() => window.innerWidth);
		const handle = await resizeHandle.boundingBox();
		if (!handle) throw new Error("Missing the right panel resize handle");
		const handleY = handle.y + handle.height / 2;
		await page.mouse.move(handle.x + handle.width / 2, handleY);
		await page.mouse.down();
		await page.mouse.move(0, handleY, { steps: 10 });
		await page.mouse.up();
		await expect(rightPanel).toHaveCSS("width", `${viewportWidth}px`);
		await expect.poll(async () => (await rightPanel.boundingBox())?.x).toBe(0);
		await expect(tree).toBeVisible();
		await expect(preview).toBeVisible();
		await page.mouse.move(3, handleY);
		await page.mouse.down();
		await page.mouse.move(viewportWidth - 460, handleY, { steps: 10 });
		await page.mouse.up();
		await expect(rightPanel).toHaveCSS("width", "460px");
		await page.getByRole("button", { name: "Close panel" }).click();

		// Deliver a deterministic reply through the regular renderer event route.
		await once(imageServer.listen(0, "127.0.0.1"), "listening");
		const imageAddress = imageServer.address();
		if (!imageAddress || typeof imageAddress === "string") throw new Error("Image fixture has no port");
		const tabId = await page.evaluate(async () => (await window.omp.tabs.list()).find(tab => tab.active)?.tabId);
		expect(tabId).toBeTruthy();
		await app.evaluate(
			({ BrowserWindow }, input) => {
				BrowserWindow.getAllWindows()[0]?.webContents.send(input.channel, {
					tabId: input.tabId,
					payload: [
						{
							type: "message_end",
							message: {
								role: "assistant",
								timestamp: Date.now(),
								stopReason: "stop",
								content: [{ type: "text", text: input.markdown }],
							},
						},
					],
				});
			},
			{
				channel: IPC_EVENTS.EVENTS_BATCH,
				tabId,
				markdown: [
					"## Drawing review",
					"Check the units before handing off the file.",
					"| Field | Value |\n| --- | --- |\n| Length | 250 mm |",
					"```ts\nconst length = 250;\n```",
					`![Remote drawing](http://127.0.0.1:${imageAddress.port}/diagram.png)`,
				].join("\n\n"),
			},
		);
		const transcript = page.locator(".omp-transcript-scroll");
		await expect(transcript.getByRole("heading", { name: "Drawing review" })).toBeVisible();
		await expect(transcript.getByRole("cell", { name: "250 mm" })).toBeVisible();
		await expect(transcript.locator("pre")).toContainText("const length = 250;");
		const loadImage = transcript.getByRole("button", { name: "Load image", exact: true });
		await expect(loadImage).toBeVisible();
		expect(imageRequests).toBe(0);
		await loadImage.click();
		const remoteImage = transcript.getByRole("button", { name: "Remote drawing", exact: true });
		await expect(remoteImage).toBeVisible();
		await expect(remoteImage).toHaveJSProperty("naturalWidth", 1);
		await page.screenshot({ path: "test-results/conversation-layout.png", scale: "css", animations: "disabled" });
		expect(imageRequests).toBe(1);
		await remoteImage.click();
		await expect(preview.locator('img[alt="Remote drawing"]')).toBeVisible();
		expect(imageRequests).toBe(1);
		await page.getByRole("button", { name: "Close panel" }).click();

		// Drive the real Add Project action with a deterministic native-picker result.
		await app.evaluate(({ dialog }, folder) => {
			const showOpenDialog = dialog.showOpenDialog;
			dialog.showOpenDialog = async () => {
				dialog.showOpenDialog = showOpenDialog;
				return { canceled: false, filePaths: [folder] };
			};
		}, addedProject);
		await page.getByRole("button", { name: "Add project…", exact: true }).click();
		const projectRow = page.locator("[data-workspace-group]").filter({ hasText: "drawing-folder" });
		await expect(projectRow).toBeVisible();
		await projectRow.hover();
		await projectRow.getByRole("button", { name: "Workspace actions", exact: true }).click();
		await page.getByRole("menuitem", { name: "Edit project", exact: true }).click();
		const editProject = page.getByRole("dialog", { name: "Edit project", exact: true });
		await expect(editProject).toContainText(addedProject);
		const alias = editProject.getByRole("textbox", { name: "Display name" });
		await expect(alias).toHaveValue("drawing-folder");
		await alias.fill("Delivery drawings");
		await editProject.getByRole("textbox", { name: /Project instructions/ }).fill("Use millimetres in drawings.");
		await editProject.getByRole("button", { name: "Save", exact: true }).click();
		await expect(editProject).toHaveCount(0);
		await expect(page.locator("[data-workspace-group]").filter({ hasText: "Delivery drawings" })).toBeVisible();
		const profiles = await page.evaluate(() => window.omp.prefs.get("launchProfiles"));
		expect(profiles).toMatchObject({ [addedProject]: { appendSystemPrompt: "Use millimetres in drawings." } });
		expect((await fs.stat(addedProject)).isDirectory()).toBe(true);

		await page.getByRole("button", { name: /^Scheduled tasks/i }).click();
		const tasksPane = page.locator(".omp-inspector").getByRole("region", { name: "Scheduled Tasks", exact: true });
		await expect(tasksPane).toBeVisible();
		await expect(composer).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page.getByRole("button", { name: "Plugins", exact: true }).click();
		const pluginsPane = page.locator(".omp-inspector").getByRole("region", { name: "Plugins", exact: true });
		await expect(pluginsPane).toBeVisible();
		await expect(tasksPane).toHaveCount(0);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await pluginsPane.getByRole("button", { name: "Close panel", exact: true }).click();

		await fs.writeFile("test-results/runtime-selection.json", JSON.stringify(runtime, null, 2));
		const evidence = await page.evaluate(
			async exportPath => {
				const rpc = window.omp.rpc;
				const before = await rpc.getState();
				const settings = await rpc.getSettings();
				const schema = await rpc.getSettingsSchema();
				const brokerSet = await rpc.setSetting("auth.broker.url", "http://127.0.0.1:9/gui-audit");
				const brokerReset = await rpc.setSetting("auth.broker.url", undefined);
				const brokerAfterReset = await rpc.getSettings(["auth.broker.url"]);
				const changed = await rpc.setSetting("compaction.enabled", false);
				const effective = await rpc.getState();
				const changes = await rpc.getGitChanges();
				const jobs = await rpc.getJobs();
				const shell = await rpc.bash("printf 'arm audit ok'");
				const saved = await rpc.getState();
				const sessionPath = saved.success && (saved.data as RpcSessionState).sessionFile;
				if (!sessionPath) throw new Error("Local command did not persist a restorable session");
				const fresh = await rpc.newSession();
				const restored = await rpc.switchSession(sessionPath);
				const transcript = await rpc.getTranscript();
				const exported = await rpc.exportHtml(exportPath);
				return {
					before,
					settings,
					schema,
					brokerSet,
					brokerReset,
					brokerAfterReset,
					changed,
					effective,
					changes,
					jobs,
					shell,
					saved,
					fresh,
					restored,
					transcript,
					exported,
				};
			},
			path.join(profile, "audit-export.html"),
		);
		for (const response of Object.values(evidence)) expect(response.success, JSON.stringify(response)).toBe(true);
		expect(evidence.brokerAfterReset.data).toMatchObject({ values: {} });
		expect(
			(evidence.brokerAfterReset.data as { values: Record<string, unknown> }).values["auth.broker.url"],
		).toBeUndefined();
		expect(evidence.changed.data).toMatchObject({ value: false });
		expect(evidence.effective.data).toMatchObject({ autoCompactionEnabled: false });
		expect(evidence.changes.data).toMatchObject({ isRepo: false });
		await fs.writeFile("test-results/real-core-contract.json", JSON.stringify(evidence, null, 2));
		expect(JSON.stringify(evidence.transcript.data)).toContain("arm audit ok");
		const exportWindow = app.waitForEvent("window");
		await app.evaluate(
			({ BrowserWindow }, url) => {
				const win = new BrowserWindow({ width: 1100, height: 800 });
				void win.loadURL(url);
			},
			pathToFileURL(path.join(profile, "audit-export.html")).href,
		);
		const exportPage = await exportWindow;
		await expect(exportPage.locator("#messages")).toContainText("arm audit ok");
		await exportPage.screenshot({ path: "test-results/exported-session.png", scale: "css", animations: "disabled" });
		await exportPage.close();
		await page.screenshot({ path: "test-results/04-real-core.png", scale: "css", animations: "disabled" });
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const original = evidence.saved.data as RpcSessionState;
		await page.locator("textarea").first().fill("/new");
		await page.getByRole("button", { name: "Send (Enter)", exact: true }).click();
		await expect
			.poll(async () => {
				const state = await page.evaluate(() => window.omp.rpc.getState());
				return state.success ? (state.data as RpcSessionState).sessionId : original.sessionId;
			})
			.not.toBe(original.sessionId);
		await expect(page.getByText("The originating session was replaced or closed.", { exact: false })).toHaveCount(0);
		await page.evaluate(async sessionPath => {
			const result = await window.omp.rpc.switchSession(sessionPath);
			if (!result.success) throw new Error(result.error);
		}, original.sessionFile!);
		await page.reload();
		await expect(page.locator("[data-transcript-kind]")).toContainText(["arm audit ok"]);
		await closeWelcome("Welcome to omp", "Close");
		// App-wide tools live in the sidebar's "More" menu.
		await page.getByRole("button", { name: "Show more navigation", exact: true }).click();
		await page.getByRole("menuitem", { name: /^Session stats/ }).click();
		const stats = page.locator(".omp-inspector").getByRole("region");
		await expect(stats).toBeVisible();
		for (const label of [
			"Overview",
			"Models",
			"Providers",
			"Tools",
			"Costs",
			"Errors",
			"Frustration",
			"Gain",
			"Projects",
			"Requests",
		]) {
			await stats.locator("nav").getByRole("button", { name: label, exact: true }).click();
			await expect(stats.getByText("Loading stats…", { exact: true })).toHaveCount(0, { timeout: 30000 });
			await expect(stats).not.toContainText("Stats unavailable", { timeout: 15000 });
			await page.screenshot({ path: `test-results/stats-${label}.png`, scale: "css", animations: "disabled" });
		}
		await page.keyboard.press("Escape");
		await page.evaluate(async () => {
			await window.omp.prefs.set("language", "zh");
		});
		await page.reload();
		await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
		await closeWelcome("欢迎使用 omp", "关闭");
		await page.getByRole("button", { name: "设置", exact: true }).click();
		const settings = page.getByRole("dialog");
		const settingsNav = settings.getByRole("navigation");
		await expect(settingsNav.getByRole("button", { name: "安全中心", exact: true })).toBeAttached();
		for (const name of ["界面", "外观", "交互"]) {
			await expect(settingsNav.getByRole("button", { name, exact: true })).toHaveCount(0);
		}
		await expect(settingsNav.locator("[aria-expanded]")).toHaveCount(0);
		const settingsPages: Array<{ page: string; text: string }> = [];
		const pages = settingsNav.locator(".settings-nav-item");
		const count = await pages.count();
		for (let pageIndex = 0; pageIndex < count; pageIndex++) {
			const target = pages.nth(pageIndex);
			const pageName = (await target.textContent()) ?? "";
			await target.click();
			await expect(settings.locator(".settings-content .animate-spin")).toHaveCount(0, { timeout: 30_000 });
			const content = settings.locator(".settings-content");
			await expect(content).not.toContainText("Something went wrong");
			await expect(content).not.toContainText("Typo Detection (macOS)");
			await expect(content).not.toContainText("Word Autocomplete (macOS)");
			await expect(content).not.toContainText("Autocorrect (macOS)");
			settingsPages.push({ page: pageName, text: (await content.textContent()) ?? "" });
			await page.screenshot({
				path: `test-results/settings-${pageIndex}.png`,
				scale: "css",
				animations: "disabled",
			});
		}
		await settingsNav.getByRole("button", { name: "常规", exact: true }).click();
		await expect(settings.locator('[id="setting-autoResume"]')).toBeAttached();
		const displayRow = settings.locator("#setting-gui-showTokenUsage");
		await displayRow.getByRole("switch").click();
		await expect(displayRow).not.toContainText("使用原设置");
		const resetDisplay = displayRow.getByRole("button", { name: "恢复跟随终端", exact: true });
		await resetDisplay.click();
		await expect(resetDisplay).toHaveCount(0);
		await settingsNav.getByRole("button", { name: "返回对话", exact: true }).click();
		await expect(settings).toHaveCount(0);
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await fs.writeFile("test-results/settings-pages.json", JSON.stringify(settingsPages, null, 2));
		const settingsSearch = page.getByRole("dialog").getByPlaceholder("搜索设置…");
		await settingsSearch.fill("bash.patterns");
		await page
			.getByRole("button")
			.filter({ has: page.getByText("bash.patterns", { exact: true }) })
			.click();
		const rules = page.locator('[id="setting-bash.patterns"]');
		await expect(rules.locator("textarea")).toHaveValue("[]");
		const rule = { match: "echo audit-blocked", approval: "deny" };
		await rules.locator("textarea").fill(JSON.stringify([rule]));
		await rules.getByRole("button", { name: "应用", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["bash.patterns"])))
			.toMatchObject({ success: true, data: { values: { "bash.patterns": [rule] } } });
		await rules.locator("textarea").fill("[]");
		await rules.getByRole("button", { name: "应用", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["bash.patterns"])))
			.toMatchObject({ success: true, data: { values: { "bash.patterns": [] } } });
		await page.getByRole("dialog").getByRole("button", { name: "常规", exact: true }).click();
		await expect(page.getByRole("dialog")).toContainText("选择 GUI 主题");
		await page.screenshot({ path: "test-results/05-packaged-zh.png", scale: "css", animations: "disabled" });
		await page.keyboard.press("Escape");
		const backgrounds: string[] = [];
		for (const theme of ["瓷白", "石墨"]) {
			await page.getByRole("button", { name: "选择主题", exact: true }).click();
			const picker = page.getByRole("dialog", { name: "选择主题", exact: true });
			await picker.getByPlaceholder("搜索主题…").fill(theme);
			await picker.locator("button[aria-pressed]").filter({ hasText: theme }).click();
			await expect(picker).toHaveCount(0);
			backgrounds.push(
				await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary")),
			);
			await page.screenshot({
				path: `test-results/packaged-theme-${theme}.png`,
				scale: "css",
				animations: "disabled",
			});
		}
		expect(backgrounds[0]).not.toBe(backgrounds[1]);
		// Delay the real IPC boot snapshot while the user makes a newer choice.
		const bootPrefs = await page.evaluate(async () => {
			await window.omp.prefs.set("fontSize", 18);
			return window.omp.prefs.get();
		});
		await app.evaluate(({ ipcMain }, prefs) => {
			const pending = Promise.withResolvers<void>();
			Reflect.set(globalThis, "releaseAuditPrefs", pending.resolve);
			ipcMain.removeHandler("prefs:get");
			ipcMain.handle("prefs:get", async (_event, payload: { key?: string }) => {
				if (payload.key) return (prefs as Record<string, unknown>)[payload.key];
				Reflect.set(globalThis, "auditPrefsRequested", true);
				await pending.promise;
				return prefs;
			});
		}, bootPrefs);
		await page.reload();
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditPrefsRequested"))).toBe(true);
		await expect(page.getByRole("button", { name: "选择主题", exact: true })).toBeVisible();
		// Preferences are held below, so startup can still be in either locale.
		await closeWelcome(/^(Welcome to omp|欢迎使用 omp)$/, /^(Close|关闭)$/);
		await page.getByRole("button", { name: "选择主题", exact: true }).click();
		const freshPicker = page.getByRole("dialog", { name: "选择主题", exact: true });
		await freshPicker.getByPlaceholder("搜索主题…").fill("瓷白");
		await freshPicker.locator("button[aria-pressed]").filter({ hasText: "瓷白" }).click();
		await expect(freshPicker).toHaveCount(0);
		const chosenBackground = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary"),
		);
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("dialog").getByRole("button", { name: "常规", exact: true }).click();
		const font = page.locator('#setting-gui-fontSize input[type="number"]');
		const chosenFont = await font.inputValue();
		for (const value of [String(Number(chosenFont) + 1), chosenFont]) {
			await font.fill(value);
			await font.press("Enter");
			await expect
				.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--gui-font-size")))
				.toBe(`${value}px`);
		}
		await page.keyboard.press("Escape");
		await app.evaluate(() => Reflect.get(globalThis, "releaseAuditPrefs")());
		await page.evaluate(async () => {
			await window.omp.prefs.get();
			const { promise, resolve } = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			await promise;
		});
		expect(
			await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary")),
		).toBe(chosenBackground);
		expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--gui-font-size"))).toBe(
			`${chosenFont}px`,
		);
		expect(errors).toEqual([]);
	} finally {
		imageServer.closeAllConnections();
		imageServer.close();
		await fs.writeFile("test-results/main-process.log", mainOutput.join(""));
		// The production quit guard intentionally blocks `app.quit()` while a
		// sidecar is active; test teardown must bypass that user confirmation.
		await app.evaluate(({ app }) => app.exit(0));
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 });
	}
});
