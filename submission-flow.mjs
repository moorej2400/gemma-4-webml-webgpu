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

  submit(prompt) {
    // Preserve one promise identity so repeated UI events join the same work.
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#run(prompt).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #run(prompt) {
    if (!this.#isReady()) await this.#load();
    if (!this.#isReady()) return { status: "not-ready", prompt };
    await this.#generate(prompt);
    return { status: "sent", prompt };
  }
}
