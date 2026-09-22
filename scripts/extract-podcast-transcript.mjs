#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv[2] || '.');
const manifestPath = join(directory, 'source-manifest.json');
const sourcePath = join(directory, 'source-export.json');
const verificationPath = join(directory, 'verification.json');
const normalizedPath = join(directory, 'normalized-transcript.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const fail = (manifest, errors, source = {}) => {
  rmSync(normalizedPath, { force: true });
  writeJson(verificationPath, { status: 'fail', source: { videoId: manifest?.videoId, title: manifest?.title, channel: manifest?.channel, ...source }, errors });
  process.stderr.write(`${errors.join('; ')}\n`);
  process.exitCode = 1;
};
const manifestErrors = manifest => {
  const errors = [];
  if (typeof manifest?.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(manifest.videoId)) errors.push('manifest videoId must be an 11-character YouTube ID');
  if (typeof manifest?.title !== 'string' || !manifest.title.trim()) errors.push('manifest title must be nonempty');
  if (typeof manifest?.channel !== 'string' || !manifest.channel.trim()) errors.push('manifest channel must be nonempty');
  if (typeof manifest?.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)) errors.push('manifest sourceSha256 must be a lowercase SHA-256');
  if (!Number.isInteger(manifest?.maxAllowedInterSegmentGapSeconds) || manifest.maxAllowedInterSegmentGapSeconds < 0) errors.push('manifest maxAllowedInterSegmentGapSeconds must be a nonnegative integer');
  const chapters = manifest?.requiredChapterStartsSeconds;
  if (!Array.isArray(chapters) || !chapters.length || chapters.some(value => !Number.isInteger(value) || value < 0) || new Set(chapters).size !== chapters.length || chapters.some((value, index) => index && value <= chapters[index - 1])) errors.push('manifest requiredChapterStartsSeconds must be a nonempty ascending list of unique nonnegative integers');
  return errors;
};

let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
catch (error) { fail(null, [`source manifest JSON parse failed: ${error.message}`]); process.exit(); }
const invalidManifest = manifestErrors(manifest);
if (invalidManifest.length) { fail(manifest, invalidManifest); process.exit(); }
let raw;
try { raw = readFileSync(sourcePath, 'utf8'); }
catch (error) { fail(manifest, [`source export unavailable: ${error.message}`]); process.exit(); }
let source;
try { source = JSON.parse(raw); }
catch (error) { fail(manifest, [`source export JSON parse failed: ${error.message}`], { sha256: sha256(raw), jsonParseable: false }); process.exit(); }

const errors = [];
const sourceSha256 = sha256(raw);
if (sourceSha256 !== manifest.sourceSha256) errors.push('source SHA-256 mismatch');
const page = typeof source.webpageMarkdown === 'string' ? source.webpageMarkdown : '';
if (!page.includes(`watch?v=${manifest.videoId}`)) errors.push('source video ID mismatch');
if (!page.includes(manifest.title)) errors.push('source title mismatch');
if (!page.includes(manifest.channel)) errors.push('source channel mismatch');
const transcript = source.videoContent?.transcript;
if (!transcript?.hasTranscript || typeof transcript.data !== 'string') errors.push('source transcript unavailable');
const entries = [];
if (!errors.includes('source transcript unavailable')) {
  const lines = transcript.data.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\[(\d+):([0-5]\d)\]\s+(\S(?:.*\S)?)$/);
    if (!match) { errors.push(`invalid transcript line ${index + 1}: expected [MM:SS] nonempty text`); continue; }
    entries.push({ startSeconds: Number(match[1]) * 60 + Number(match[2]), text: match[3] });
  }
  if (!entries.length) errors.push('source transcript has no timestamped segments');
}
for (let index = 1; index < entries.length; index++) {
  const previous = entries[index - 1].startSeconds, current = entries[index].startSeconds;
  if (current < previous) errors.push(`timestamps are not monotonic at segment ${index + 1}`);
  if (current - previous > manifest.maxAllowedInterSegmentGapSeconds) errors.push(`inter-segment gap exceeds maximum at ${current}s (${current - previous}s > ${manifest.maxAllowedInterSegmentGapSeconds}s)`);
}
for (const chapterStart of manifest.requiredChapterStartsSeconds) {
  if (!entries.some(entry => entry.startSeconds <= chapterStart && chapterStart - entry.startSeconds <= manifest.maxAllowedInterSegmentGapSeconds)) errors.push(`required chapter coverage missing at ${chapterStart}s`);
}
const finalChapter = manifest.requiredChapterStartsSeconds.at(-1);
if (!entries.some(entry => entry.startSeconds >= finalChapter)) errors.push(`transcript ends before final required chapter at ${finalChapter}s`);
if (errors.length) { fail(manifest, [...new Set(errors)], { sha256: sourceSha256, jsonParseable: true, segmentCount: entries.length }); process.exit(); }

const normalized = { status: 'eligible-as-input', source: { videoId: manifest.videoId, title: manifest.title, channel: manifest.channel, sha256: sourceSha256 }, segments: entries };
const verification = { status: 'pass', source: { videoId: manifest.videoId, title: manifest.title, channel: manifest.channel, sha256: sourceSha256, jsonParseable: true, segmentCount: entries.length }, checks: { timestampsMonotonic: true, maxAllowedInterSegmentGapSeconds: manifest.maxAllowedInterSegmentGapSeconds, requiredChapterStartsSeconds: manifest.requiredChapterStartsSeconds } };
writeJson(normalizedPath, normalized);
writeJson(verificationPath, verification);
process.stdout.write(`${JSON.stringify(verification)}\n`);
