import { describe, expect, it } from "vitest";
import { appendMentions, droppedFileMention, removeMention } from "./input-area-utils";

describe("droppedFileMention", () => {
	it("makes files under the workspace relative", () => {
		expect(droppedFileMention("/work/app/src/index.ts", "/work/app")).toBe("@src/index.ts");
		expect(droppedFileMention("/work/app/src/index.ts", "/work/app/")).toBe("@src/index.ts");
	});

	it("keeps files outside the workspace absolute, including sibling prefixes", () => {
		expect(droppedFileMention("/tmp/notes.md", "/work/app")).toBe("@/tmp/notes.md");
		expect(droppedFileMention("/work/application/a.ts", "/work/app")).toBe("@/work/application/a.ts");
	});

	it("quotes paths with whitespace so the agent parses them whole", () => {
		expect(droppedFileMention("/work/app/My Docs/plan.md", "/work/app")).toBe('@"My Docs/plan.md"');
	});

	it("normalizes Windows separators when matching the workspace", () => {
		expect(droppedFileMention("C:\\work\\app\\src\\a.ts", "C:\\work\\app")).toBe("@src/a.ts");
	});

	it("quotes punctuation that the agent would trim or split", () => {
		expect(droppedFileMention("/work/app/[a]@b.ifc", "/work/app")).toBe('@"[a]@b.ifc"');
		expect(droppedFileMention('/work/app/model "final".ifc', "/work/app")).toBe(`@'model "final".ifc'`);
	});
});

describe("appendMentions", () => {
	it("separates mentions from the draft with single spaces and leaves the caret after a space", () => {
		expect(appendMentions("", ["@a.ts"])).toBe("@a.ts ");
		expect(appendMentions("look at", ["@a.ts", "@b.ts"])).toBe("look at @a.ts @b.ts ");
		expect(appendMentions("look at ", ["@a.ts"])).toBe("look at @a.ts ");
		expect(appendMentions("unchanged", [])).toBe("unchanged");
	});
});

describe("removeMention", () => {
	it("removes just the selected attachment, preserving other draft text", () => {
		expect(removeMention('Compare @"floor plan.dwg" @plan.dwg.zip @plan.dwg ', "@plan.dwg")).toBe(
			'Compare @"floor plan.dwg" @plan.dwg.zip',
		);
		expect(removeMention('@"floor plan.dwg" then check the dimensions', '@"floor plan.dwg"')).toBe(
			"then check the dimensions",
		);
	});
});
