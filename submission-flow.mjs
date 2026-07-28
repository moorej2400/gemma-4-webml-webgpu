export class SubmissionFlow {
  #isReady;
  #load;
  #generate;
  #inFlight = null;

  constructor({ isReady, load, generate }) {
    this.#isReady = isReady;
    this.#load = load;
    this.#generate = generate;
  }

  submit(prompt, context) {
    // Repeated UI events must join the first prompt and its generation context.
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#run(prompt, context).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #run(prompt, context) {
    if (!this.#isReady()) await this.#load();
    if (!this.#isReady()) return { status: "not-ready", prompt };
    await this.#generate(prompt, context);
    return { status: "sent", prompt };
  }
}
