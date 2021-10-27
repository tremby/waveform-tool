const SIZE_MAX = 1024 * 1024 * 256;
const TARGET_SAMPLES = 1500;

const path = require("path");
const express = require("express");
const multiparty = require("multiparty");
const childProcess = require("child_process");

const app = express();
const port = process.env.PORT ?? 3000;

app.listen(port, () => {
	console.log(`App listening at http://localhost:${port}`);
});

app.use(express.static(path.resolve(__dirname, "public")));

app.post("/upload", (req, res, next) => {
	const form = new multiparty.Form();
	let file;
	let tooBig = false;

	form.on("error", next);
	form.on("field", (name, val) => {
		if (name === "file") file = val;
	});
	form.on("part", async (part) => {
		if (!part.filename) return;
		if (part.name !== "file") return part.resume();
		const chunks = [];
		let size = 0;
		for await (const chunk of part) {
			size += chunk.length;
			if (size > SIZE_MAX) tooBig = true;
			else chunks.push(chunk);
		}
		file = {
			filename: part.filename,
			data: Buffer.concat(chunks),
		};
	});
	form.on("close", () => {
		if (file == null) {
			res.send(`received no file`);
			return;
		}
		if (tooBig) {
			res.send(`received file was too big; max ${SIZE_MAX} bytes`);
			return;
		}

		// Prepare
		const commonOptions = ["--output-format", "json", "--input-format", "mp3", "-i", "-"];

		// Run it through once to get length
		let aborted = false;
		pass1 = childProcess.spawn("audiowaveform", [...commonOptions, "--pixels-per-second", "1"], {
			stdio: ["pipe", "ignore", "pipe"],
		});
		pass1.stdin.on("error", (err) => {
			res.send("Error occurred. Not an MP3?");
			console.error("Error on pass1 stdin", err);
			aborted = true;
		});
		pass1.stdin.end(file.data);
		const pass1StderrChunks = [];
		pass1.stderr.on("data", (chunk) => {
			pass1StderrChunks.push(chunk);
		});
		pass1.on("close", (pass1Code) => {
			if (aborted) return;
			const pass1Stderr = Buffer.concat(pass1StderrChunks).toString();
			if (pass1Code !== 0) {
				res.send("Info pass failed");
				console.error(`Info pass failed with code ${pass1Code}. Output: ${pass1Stderr}`);
				return;
			}
			const lines = pass1Stderr.split("\n");
			const durationLine = lines.find((line) => /^Frames decoded:/.test(line));
			if (durationLine == null) {
				res.send("Couldn't get audio duration");
				console.error(`Couldn't get audio duration. Output: ${pass1Stderr}`);
				return;
			}
			const match = durationLine.match(/\((\d+):(\d+)\.(\d+)\)/);
			if (!match) {
				res.send("Couldn't get audio duration");
				console.error(`Couldn't get audio duration. Output: ${pass1Stderr}`);
				return;
			}
			const duration = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3]) / 1e3;

			const outputSamplesPerSecond = Math.max(1, Math.round(TARGET_SAMPLES / duration));

			// Second pass to get data
			pass2 = childProcess.spawn("audiowaveform", [...commonOptions, "--bits", "8", "--amplitude-scale", "auto", "--pixels-per-second", outputSamplesPerSecond.toString()], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			pass2.stdin.on("error", (err) => {
				res.send("Error occurred. Not an MP3?");
				console.error("Error on pass2 stdin", err);
				aborted = true;
			});
			pass2.stdin.end(file.data);
			const pass2StdoutChunks = [];
			pass2.stdout.on("data", (chunk) => {
				pass2StdoutChunks.push(chunk);
			});
			const pass2StderrChunks = [];
			pass2.stderr.on("data", (chunk) => {
				pass2StderrChunks.push(chunk);
			});
			pass2.on("close", (pass2Code) => {
				if (aborted) return;
				const pass2Stderr = Buffer.concat(pass2StderrChunks);
				if (pass2Code !== 0) {
					res.send("Data pass failed");
					console.error(`Data pass failed with code ${pass2Code}. Output: ${pass2Stderr}`);
					return;
				}
				const pass2Stdout = Buffer.concat(pass2StdoutChunks);

				res.header("Content-Type", "text/html");
				res.send(`<!doctype html>
					<html>
						<head>
							<title>Waveform data results</title>
							<style type="text/css">
								dt { font-weight: bold; }
								dd { margin: 0; }
							</style>
						</head>
						<body>
							<h1>Results for file <code>${file.filename}</code></h1>
							<dl style="display: grid; grid-template-columns: max-content auto; gap: 2rem;">
								<dt>Duration</dt>
								<dd><input type="text" readonly value="${Math.floor(duration)}" size="8"> seconds</dd>
								<dt>Peaks data</dt>
								<dd><textarea readonly style="width: 100%" rows="15">${pass2Stdout}</textarea></dd>
							</dl>
							<p><a href="/">Back</a></p>
						</body>
					</html>
				`);
			});
		});
	});
	form.parse(req);
});
