import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../src/steps.mjs';

// The shape of a YouTube channel feed (Atom + Media RSS): the video text lives only in media:group/media:description.
const YOUTUBE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Channel</title>
 <entry>
  <id>yt:video:abc</id>
  <title>A talk about small software</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=abc"/>
  <published>2026-10-08T14:30:33+00:00</published>
  <media:group>
   <media:title>A talk about small software</media:title>
   <media:description>Software for one person or team, shared &amp; edited like a document.</media:description>
  </media:group>
 </entry>
</feed>`;

test('parseFeed reads the summary of a YouTube entry from media:description', () => {
  const [entry] = parseFeed(YOUTUBE);
  assert.equal(entry.title, 'A talk about small software');
  assert.equal(entry.link, 'https://www.youtube.com/watch?v=abc');
  assert.equal(entry.published, '2026-10-08T14:30:33+00:00');
  assert.equal(entry.summary, 'Software for one person or team, shared & edited like a document.');
});

test('parseFeed still prefers description/summary/content over media:description', () => {
  const rss = '<rss><channel><item><title>T</title><link>https://a.example/1</link><description>Plain</description><media:description>Media</media:description><pubDate>Thu, 01 Oct 2026 16:52:00 GMT</pubDate></item></channel></rss>';
  assert.equal(parseFeed(rss)[0].summary, 'Plain');
  // Negative: an entry with no text at all keeps an empty summary.
  assert.equal(parseFeed('<feed><entry><title>T</title><link href="https://a.example/2"/></entry></feed>')[0].summary, '');
});
