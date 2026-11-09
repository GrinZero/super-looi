export const cameraUrn =
  "urn:miot-spec-v2:device:camera:0000A02B:test-camera:1";
const property = (
  iid: number,
  name: string,
  format: string,
  access: string[] = [],
) => ({
  iid,
  type: `urn:miot-spec-v2:property:${name}:00000001:test:1`,
  description: name,
  format,
  access,
});
const action = (iid: number, name: string, input: number[], out: number[]) => ({
  iid,
  type: `urn:miot-spec-v2:action:${name}:00000001:test:1`,
  description: name,
  in: input,
  out,
});
export const cameraRawSpec = {
  type: cameraUrn,
  services: [
    {
      iid: 2,
      type: "urn:miot-spec-v2:service:camera-control:00007801:test:1",
      properties: [property(1, "on", "bool", ["read", "write"])],
    },
    {
      iid: 8,
      type: "urn:miot-spec-v2:service:camera-stream-for-amazon-alexa:00007802:test:1",
      properties: [
        {
          ...property(9, "stream-status", "uint8", ["read"]),
          "value-list": [
            { value: 1, description: "Available" },
            { value: 2, description: "In use" },
          ],
        },
      ],
      actions: [action(3, "get-stream-configuration", [], [9])],
    },
    {
      iid: 9,
      type: "urn:miot-spec-v2:service:camera-stream-for-google-home:00007803:test:1",
      properties: [
        {
          ...property(2, "video-attribute", "uint8"),
          "value-list": [{ value: 1, description: "1080p" }],
        },
        property(5, "stream-address", "string"),
        {
          ...property(9, "stream-status", "uint8", ["read"]),
          "value-list": [
            { value: 1, description: "Available" },
            { value: 2, description: "In use" },
          ],
        },
      ],
      actions: [
        action(1, "start-hls-stream", [2], [5]),
        action(2, "stop-stream", [], []),
        action(3, "get-stream-configuration", [], [9]),
      ],
    },
  ],
};
