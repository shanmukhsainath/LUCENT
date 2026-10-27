(function () {
	const paths = {
		logo: '<path d="M12 3.5 14.4 9.6 21 12l-6.6 2.4L12 20.5l-2.4-6.1L3 12l6.6-2.4L12 3.5Z"/><path d="m18.5 3 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/>',
		mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5m-4 0h8"/>',
		micOff: '<path d="M9 9v5.5a3 3 0 0 0 5.2 2M15 9V5.5a3 3 0 0 0-5.8-1M5.5 11.5a6.5 6.5 0 0 0 11.1 4.6M12 18v3.5m-4 0h8M3 3l18 18"/>',
		video: '<rect x="3" y="5" width="13" height="14" rx="2.5"/><path d="m16 10 5-3v10l-5-3"/>',
		videoOff: '<path d="M10 5h4a2 2 0 0 1 2 2v3l5-3v10l-5-3v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 1-1.7M3 3l18 18"/>',
		monitorUp: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m0-14v7m-3-4 3-3 3 3"/>',
		smile: '<circle cx="12" cy="12" r="9.5"/><path d="M8 14s1.5 2.5 4 2.5 4-2.5 4-2.5M9 9h.01M15 9h.01"/>',
		users: '<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m16 0v-2a4 4 0 0 0-3-3.9M14 3.1a4 4 0 0 1 0 7.8"/><circle cx="10" cy="7" r="4"/>',
		message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
		question: '<circle cx="12" cy="12" r="9.5"/><path d="M9.6 9a2.5 2.5 0 1 1 4.3 1.8c-1 .9-1.9 1.2-1.9 2.7M12 17h.01"/>',
		captions: '<path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="M7 10h4m-4 4h3m4-4h3m-3 4h4"/>',
		note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8m-8 4h8"/>',
		task: '<path d="m9 11 3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
		topics: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/>',
		more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
		phoneOff: '<path d="M10.7 13.3a15.1 15.1 0 0 0 4 4l2.2-2.2a1 1 0 0 1 1-.2 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17.5 17.5 0 0 1 4 3.5a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .6 3.6 1 1 0 0 1-.2 1L7.7 10M3 3l18 18"/>',
		chevron: '<path d="m7 10 5 5 5-5"/>',
		close: '<path d="m18 6-12 12M6 6l12 12"/>',
		pin: '<path d="m16 3 5 5-4 1-4 4 1 4-2 2-3-5-5 5-1-1 5-5-5-3 2-2 4 1 4-4 1-4Z"/>',
		copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
		moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
		sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
		search: '<circle cx="10.8" cy="10.8" r="7.3"/><path d="m16.2 16.2 4.3 4.3"/>',
		fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/>',
		lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
		camera: '<path d="M14 5 15.5 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4l1.5-2H14Z"/><circle cx="12" cy="13" r="3"/>',
		connection: '<path d="M5 9a11 11 0 0 1 14 0M8 12a6.5 6.5 0 0 1 8 0m-5 3a2 2 0 0 1 2 0m-1 4h.01"/>',
		clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/>',
		settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.6-1.4-2.4 1.4-1.1a8 8 0 0 1 0-1.8L6.3 12l1.4-2.4 1.7.6a8 8 0 0 1 1.5-.9l.3-1.8H14l.3 1.8a8 8 0 0 1 1.5.9l1.7-.6 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 1.9Z"/>',
		bookmark: '<path d="M6 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18l-6-4-6 4V4Z"/>',
		info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v5m0-9h.01"/>',
		check: '<path d="m5 12 4 4L19 6"/>',
	};

	const icons = Object.fromEntries(Object.entries(paths).map(([name, path]) => [
		name,
		(size = 20) => `<svg aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`,
	]));
	window.MMIcons = Object.freeze(icons);
})();