class LivePcmProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.samples = [];
		this.sampleAccumulator = 0;
		this.noiseRms = 0.002;
		this.isSpeech = false;
		this.speechCandidates = 0;
		this.silentChunks = 0;
		this.preRoll = [];
	}

	process(inputs) {
		const channels = inputs[0];
		if (!channels?.length) return true;
		const frameCount = channels[0].length;
		for (let frame = 0; frame < frameCount; frame += 1) {
			let mono = 0;
			for (const channel of channels) mono += channel[frame] || 0;
			mono /= channels.length;
			this.sampleAccumulator += 16000;
			if (this.sampleAccumulator >= sampleRate) {
				this.sampleAccumulator -= sampleRate;
				this.samples.push(mono);
			}
			if (this.samples.length === 4000) {
				const chunk = new Float32Array(this.samples);
				this.processChunk(chunk);
				this.samples = [];
			}
		}
		return true;
	}

	processChunk(chunk) {
		let sumSquares = 0;
		for (const sample of chunk) sumSquares += sample * sample;
		const rms = Math.sqrt(sumSquares / chunk.length);
		const threshold = Math.max(0.008, this.noiseRms * 2.5);

		if (!this.isSpeech) {
			if (rms < threshold) {
				this.noiseRms = this.noiseRms * 0.95 + rms * 0.05;
				this.preRoll.push(chunk);
				if (this.preRoll.length > 2) this.preRoll.shift();
				this.speechCandidates = 0;
				return;
			}
			this.preRoll.push(chunk);
			this.speechCandidates += 1;
			if (this.speechCandidates < 2) return;
			this.isSpeech = true;
			this.silentChunks = 0;
			for (const bufferedChunk of this.preRoll) this.sendChunk(bufferedChunk);
			this.preRoll = [];
			return;
		}

		this.sendChunk(chunk);
		if (rms >= threshold) {
			this.silentChunks = 0;
			return;
		}
		this.silentChunks += 1;
		if (this.silentChunks >= 3) {
			this.isSpeech = false;
			this.speechCandidates = 0;
			this.silentChunks = 0;
			this.preRoll = [];
			this.port.postMessage({ type: 'silence' });
		}
	}

	sendChunk(chunk) {
		this.port.postMessage({ type: 'audio', samples: chunk }, [chunk.buffer]);
	}
}

registerProcessor('live-pcm-processor', LivePcmProcessor);
