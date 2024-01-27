#!/usr/bin/env -S deno run --allow-read --allow-write

Array.prototype.fst = function() {
	return this[0]
}

Array.prototype.lst = function() {
	return this[this.length-1]
}

if (Deno.args.length !== 1)
	throw "only take a script file bro!"

const script = (await Deno.readTextFile(Deno.args[0]))
	.replaceAll(/\r\n/g, '\n')

const timestamp2millis = str => {
	const [, h, mm, ss, millis] = str.match(/^(\d):(\d\d):(\d\d)\.(\d\d\d)$/)
	return +h*60*60*1000 + +mm*60*1000 + +ss*1000 + +millis
}

const millis2timestamp = ms => {
	const h = Math.floor(ms/(60*60*1000))
	ms -= h*60*60*1000
	const m = Math.floor(ms/(60*1000))
	ms -= m*60*1000
	const s = Math.floor(ms/1000)
	ms -= s*1000
	const f = (n, space=2) => n.toString().padStart(space, '0')
	return `${f(h, 1)}:${f(m)}:${f(s)}.${f(ms, 3)}`
}

const combine = ({times: [a, b], lines: [xs]}, {times: [c, d], lines: [ys]}) =>
	({ times: [a, d], lines: [...xs, ...ys] })

// Sorted [time] => [[time]] (chunks of times)
const adder = (rs, max_pause_ms=1000) => {
	const res = [[rs[0]]]
	for (const range of rs.slice(1)) {
		const [x, y] = [res.pop(), [range]]
		const [{times: [a, b]}, {times: [c, d]}] = [x.fst(), y.lst()]

		if (c - b < max_pause_ms) {
			res.push([...x, ...y])
		} else {
			res.push(x, y)
		}
	}
	return res
}

// str => [parsed thing]
const parse_chunk = chunk => {
	const lines = chunk.split(/\n+/)
	if (lines[0].startsWith('#!')) {
		const m = lines[0].match(/^#!(\w+)=(.+)$/)
		if (!m) throw `error parsing commandthing: ${lines[0]}`
		return [{ type: 'cmd', data: [m[1], m[2]]}]
	}
	if (lines[0].startsWith('#'))
		return []

	const m = lines[0].match(/^([\d\:\.]+)\,([\d\:\.]+)$/)

	if (!m) throw `could not parse head line: ${lines[0]}`

	const [, ta, tb] = m

	return [{ type: 'times', times: [timestamp2millis(ta), timestamp2millis(tb)], lines: lines.slice(1) }]
}


// script of [parsed thing] => [a full thing]
const parse_things = things => {
	const env = {}
	const videos = []
	for (const x of things) {
		const { type, data } = x
		if (type==='cmd') {
			const [cmd, val] = data
			env[cmd] = val
			if (cmd === 'out')
				videos.push({ name: val, input: env.input, subs: [] })
		} else if (type === 'times') {
			if (videos.length === 0)
				throw `underflow!!`
			videos[videos.length-1].subs.push(x)
		} else {
			throw `unhandled type: ${type}`
		}
	}
	return videos
}

// sorted [sub] => [sub] where 1st sub is t=0:00:00.000
const normaliseSubs = subs => {
	const ref = subs.fst().times[0]
	// return subs
	return subs.map(sub => ({...sub, times: sub.times.map(ms => ms-ref)}))
}

// [[sub]] => [sub]
// concat sub groups, one after the other
// note: all should be normalised otherwise doesnt really work
const sequenceSubGroups = subss => {
	let curr = 0
	const res = []
	for (const subs of subss) {
		res.push(...subs.map(sub => ({...sub, times: sub.times.map(ms => curr+ms)})))
		curr = res.lst().times[1]
	}
	return res
}

// subs => sbv text
const subs2sbv = subs =>
	subs.map(({ times: [a, b], lines}) => `${millis2timestamp(a)},${millis2timestamp(b)}\n${lines.join('\n')}`)
		.join('\n\n')

const parse_subs = txt => {
	const chunks = txt.trim().split(/\n\n+/)

	const things = chunks.map(parse_chunk).flat()

	const program = parse_things(things)

	return	program
	//program.map(vid => adder(vid.subs)).map(x => x.flat())
	//	.map(normaliseSubs)
}

const groups2filter = groups => {
	const streams = groups.map((subs, i) => {
		const [a, b] = [subs.fst().times.fst(), subs.lst().times.lst()]
		const video = `[0:v]trim=start=${a}ms:end=${b}ms,setpts=PTS-STARTPTS,format=yuv420p[${i}v]`
		const audio = `[0:a]atrim=start=${a}ms:end=${b}ms,asetpts=PTS-STARTPTS[${i}a]`
		return [video, audio]
	})
	const concat = groups.map((_, i) => `[${i}v][${i}a]`).join('')
		+ `concat=n=${groups.length}:v=1:a=1[outv][outa]`
	const lines = [...streams, [concat]].flat()
	return `"${lines.join('; \\\n ')}"`
}

const section2scripts = ({name, input, subs}) => {
	const groups = adder(subs)
	const filter = groups2filter(groups)
	const sbv = subs2sbv(sequenceSubGroups(groups.map(normaliseSubs)))

	const audioi = `-i "${name}.sbv"`
	const audiomap = '-map 1:s'

	const ffsubs = `ffmpeg -i "${name}" -vf "subtitles=${name}:stream_index=0" -map 0 -map -0:s ${name}.baked.webm`

	const ffmpeg = `ffmpeg -i "${input}" ${audioi} -filter_complex \\\n${filter} -map [outv] -map [outa] ${audiomap} ${name}\n\n${ffsubs}`

	return { name, ffmpeg, sbv }
}

const scripts2io = ({ name, ffmpeg, sbv }) => {
	return [[`${name}.sh`, `#!/bin/bash\n\n${ffmpeg}\n`], [`${name}.sbv`, `${sbv}\n`]]//Deno.writeTextFile()
}

const windowfy_io = x => {
	const [file, contents]= x
	if (file.endsWith('.sh')) {
		return [file.replace(/\.sh$/, '.ps1'), contents.replaceAll('ffmpeg', '.\\ffmpeg.exe').replace(/ \\$/mg, ' `')]
	}
	return x
}

// console.log("#!/bin/bash")
console.log(await Promise.all(
	parse_subs(script).map(section2scripts)
		.map(scripts2io).flat()
		.map(windowfy_io)
		.map(xs => Deno.writeTextFile(...xs))
))
