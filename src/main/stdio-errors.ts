/** Keep a detached launcher's output stream from interrupting the desktop app. */
export function handleStdioDisconnects(
	stream: NodeJS.WritableStream,
	report: (error: NodeJS.ErrnoException) => void,
): void {
	let reported = false;
	stream.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EIO" && error.code !== "EPIPE") throw error;
		if (reported) return;
		reported = true;
		report(error);
	});
}
