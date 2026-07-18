const processes = [
  Bun.spawn(["bun", "run", "dev:server"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "run", "dev:client"], { stdout: "inherit", stderr: "inherit" }),
];

const stop = () => processes.forEach((process) => process.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.race(processes.map((process) => process.exited));
stop();

export {};
