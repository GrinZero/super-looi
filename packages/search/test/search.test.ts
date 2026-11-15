import assert from "node:assert/strict";
import { test } from "node:test";
import { rankDocuments, type SearchDocument } from "../src/index.js";

const documents: SearchDocument[] = [
  { id: "light.desk", name: "客厅台灯", text: "台灯 灯 照明 亮度", context: "客厅" },
  { id: "light.ceiling", name: "客厅吸顶灯", text: "吸顶灯 灯 照明 亮度", context: "客厅" },
  { id: "light.bedroom", name: "卧室台灯", text: "台灯 灯 照明 亮度", context: "卧室" },
  { id: "climate.living", name: "客厅空调", text: "空调 制冷 温度", context: "客厅" },
];
const ids = (query: string, docs = documents) => rankDocuments(query, docs).map(match => match.id);

test("Chinese queries are segmented across names, descriptions and context", () => {
  assert.equal(ids("客厅的台灯")[0], "light.desk");
  assert.equal(ids("客厅 照明")[0], "light.desk");
  assert.deepEqual(new Set(ids("卧室")), new Set(["light.bedroom"]));
});

test("query word order and repeated words do not change ranking", () => {
  assert.deepEqual(ids("客厅 灯"), ids("灯 客厅"));
  assert.deepEqual(rankDocuments("客厅 灯 灯", documents), rankDocuments("客厅 灯", documents));
});

test("query coverage outranks a stronger match of just one word", () => {
  const docs = [
    { id: "partial", name: "灯", text: "灯 灯 灯 灯" },
    { id: "both", name: "设备", text: "灯", context: "客厅" },
  ];
  assert.deepEqual(ids("客厅 灯", docs), ["both", "partial"]);
  assert.deepEqual(rankDocuments("客厅 灯", docs).map(match => match.matchedTerms), [2, 1]);
});

test("exact Unicode names and identifiers outrank partial name matches", () => {
  const docs = [
    { id: "other", name: "台灯 照明", text: "台灯" },
    { id: "light.desk", name: "台灯", text: "灯" },
    { id: "same-length", name: "吊灯", text: "台灯" },
  ];
  assert.equal(ids("台灯", docs)[0], "light.desk");
  assert.equal(ids(" LIGHT.DESK ", docs)[0], "light.desk");
  assert.equal(rankDocuments(" LIGHT.DESK ", docs)[0].exact, true);
  assert.equal(rankDocuments("台灯", docs).find(match => match.id === "same-length")?.exact, false);
  assert.equal(ids("cafe\u0301", [
    { id: "partial", name: "Café reviews", text: "Café" },
    { id: "exact", name: "CAFÉ" },
  ])[0], "exact");
});

test("names weigh more than descriptions and shared context", () => {
  assert.deepEqual(ids("coffee", [
    { id: "context", name: "Orders", context: "coffee" },
    { id: "text", name: "Orders", text: "coffee" },
    { id: "name", name: "Coffee orders" },
  ]), ["name", "text", "context"]);
});

test("BM25 gives rare terms more weight and normalizes description length", () => {
  assert.deepEqual(ids("coffee tea", [
    { id: "tea-one", name: "Order 1", text: "tea" },
    { id: "tea-two", name: "Order 2", text: "tea" },
    { id: "coffee", name: "Order 3", text: "coffee" },
  ]), ["coffee", "tea-one", "tea-two"]);
  assert.deepEqual(ids("coffee", [
    { id: "long", name: "Order", text: "coffee with several unrelated words describing breakfast pastries" },
    { id: "short", name: "Order", text: "coffee" },
  ]), ["short", "long"]);
});

test("English plural forms, camelCase and punctuation separated identifiers are searchable", () => {
  assert.equal(ids("search issue", [{ id: "api.searchIssues", name: "IssueSearch", text: "Searches issues" }])[0], "api.searchIssues");
  assert.equal(ids("living room ceiling", [{ id: "light.living_room_ceiling", name: "吸顶灯" }])[0], "light.living_room_ceiling");
});

test("case-insensitive exact names and IDs remain matches when token boundaries differ", () => {
  const docs = [{ id: "api.searchIssues", name: "LivingRoomLight" }];
  for (const query of ["LivingRoomLight", "livingroomlight", "LIVINGROOMLIGHT", "api.searchissues", "API.SEARCHISSUES"]) {
    const matches = rankDocuments(query, docs);
    assert.equal(matches[0].id, "api.searchIssues");
    assert.equal(matches[0].exact, true);
  }
  assert.equal(rankDocuments("AND", [{ id: "conjunction", name: "And" }])[0].exact, true);
});

test("unmatched and empty queries produce no matches; empty query listing belongs to the caller", () => {
  for (const query of ["", "  ", "!!!", "and the", "热水器"]) assert.deepEqual(ids(query), []);
  assert.deepEqual(ids("coffee", []), []);
});

test("ties retain input order and the complete result can be paginated by the caller", () => {
  const docs = Array.from({ length: 65 }, (_, i) => ({ id: String(i), name: "台灯", context: "客厅" }));
  const matches = rankDocuments("客厅 灯", docs);
  assert.equal(matches.length, 65);
  assert.deepEqual(matches.slice(30, 60).map(match => match.id), docs.slice(30, 60).map(doc => doc.id));
  assert.ok(matches.every(match => match.score > 0));
  assert.deepEqual(docs.map(doc => doc.id), Array.from({ length: 65 }, (_, i) => String(i)));
});
