import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { handleStdioDisconnects } from "./stdio-errors";

function outputStream(): Writable {
	return new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
}

describe("main process standard output errors", () => {
	it.each(["EIO", "EPIPE"])("handles %s from a detached output stream once", code => {
		const stream = outputStream();
		const reports: Error[] = [];
		handleStdioDisconnects(stream, error => reports.push(error));
		const error = Object.assign(new Error(`write ${code}`), { code, syscall: "write" });

		expect(() => stream.emit("error", error)).not.toThrow();
		expect(() => stream.emit("error", error)).not.toThrow();
		expect(reports).toEqual([error]);
	});

	it("continues after an asynchronous write failure", async () => {
		const error = Object.assign(new Error("write EIO"), { code: "EIO", syscall: "write" });
		const stream = new Writable({
			write(_chunk, _encoding, callback) {
				setImmediate(() => callback(error));
			},
		});
		const reports: Error[] = [];
		handleStdioDisconnects(stream, failure => reports.push(failure));
		const closed = new Promise<void>(resolve => stream.once("close", resolve));
		stream.write("starting sidecar\n");
		await closed;
		expect(reports).toEqual([error]);
	});

	it("preserves unrelated stream failures even after a disconnect", () => {
		const stream = outputStream();
		handleStdioDisconnects(stream, () => {});
		stream.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" }));
		const error = Object.assign(new Error("write ENOSPC"), { code: "ENOSPC", syscall: "write" });
		expect(() => stream.emit("error", error)).toThrow(error);
	});

	it("leaves successful output intact", () => {
		const chunks: string[] = [];
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(chunk.toString());
				callback();
			},
		});
		const reports: Error[] = [];
		handleStdioDisconnects(stream, error => reports.push(error));
		stream.write("starting sidecar\n");
		expect(chunks).toEqual(["starting sidecar\n"]);
		expect(reports).toEqual([]);
	});
});
