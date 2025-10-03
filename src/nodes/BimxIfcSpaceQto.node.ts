// innerhalb properties: [...]
{
  displayName: "All Parameters",
  name: "allParameters",
  type: "boolean",
  default: false,
},
{
  displayName: "Use Geometry Fallback",
  name: "useGeometryFallback",
  type: "boolean",
  default: true,
},
{
  displayName: "Force Geometry",
  name: "forceGeometry",
  type: "boolean",
  default: false,
},
{
  displayName: "Add options",
  name: "addOptions",
  type: "collection",
  placeholder: "Add option",
  default: {},
  options: [
    {
      displayName: "Parameter Names",
      name: "select",
      type: "string",
      typeOptions: { multipleValues: true, multipleValueButtonText: "Add Parameter" },
      default: [],
      description: "Zusätzliche Feldnamen, die (falls vorhanden) ausgelesen werden sollen",
    },
    {
      displayName: "Rename",
      name: "rename",
      type: "fixedCollection",
      typeOptions: { multipleValues: true },
      default: {},
      options: [
        {
          name: "map",
          displayName: "Map",
          values: [
            { displayName: "ParameterName", name: "key", type: "string", default: "" },
            { displayName: "NewName", name: "val", type: "string", default: "" },
          ],
        },
      ],
    },
  ],
},
