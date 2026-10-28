// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { readBinary, toBinary } from "./binary";

const OPERATIONS = ["info", "resize", "crop", "rotate", "blur", "grayscale", "convert"] as const;
const FORMATS = ["keep", "jpeg", "png", "webp", "avif"] as const;
const FITS = ["cover", "contain", "fill", "inside", "outside"] as const;

const config = z.object({
  operation: z
    .enum(OPERATIONS)
    .default("resize")
    .meta({
      title: "Operation",
      labels: {
        info: "Get Information",
        resize: "Resize",
        crop: "Crop",
        rotate: "Rotate",
        blur: "Blur",
        grayscale: "Grayscale",
        convert: "Convert Format",
      },
      hints: {
        info: "Get the width, height, and format of the image",
        resize: "Make the image bigger or smaller",
        crop: "Cut a part out of the image",
        rotate: "Turn the image by an angle",
        blur: "Blur the image",
        grayscale: "Make the image black and white",
        convert: "Save the image in another format",
      },
    }),
  property: z.string().min(1).default("data").meta({
    title: "Input Binary Field",
    description: "The image is in binary.<property> of the input",
  }),
  outputProperty: z
    .string()
    .min(1)
    .default("data")
    .meta({
      title: "Output Binary Field",
      description: "The new image goes to binary.<property> of the output",
      showWhen: { operation: ["resize", "crop", "rotate", "blur", "grayscale", "convert"] },
    }),
  width: z
    .number()
    .int()
    .min(1)
    .max(20_000)
    .optional()
    .meta({
      title: "Width",
      description: "In pixels. Resize: empty keeps the ratio.",
      showWhen: { operation: ["resize", "crop"] },
    }),
  height: z
    .number()
    .int()
    .min(1)
    .max(20_000)
    .optional()
    .meta({
      title: "Height",
      description: "In pixels. Resize: empty keeps the ratio.",
      showWhen: { operation: ["resize", "crop"] },
    }),
  fit: z
    .enum(FITS)
    .default("inside")
    .meta({
      title: "Fit",
      labels: {
        cover: "Cover",
        contain: "Contain",
        fill: "Fill",
        inside: "Inside",
        outside: "Outside",
      },
      hints: {
        cover: "Fill the size and cut what is outside",
        contain: "Fit inside the size and add empty space",
        fill: "Stretch to the exact size",
        inside: "Fit inside the size and keep the ratio",
        outside: "Cover the size and keep the ratio",
      },
      showWhen: { operation: ["resize"] },
    }),
  left: z
    .number()
    .int()
    .min(0)
    .default(0)
    .meta({
      title: "Left",
      description: "Pixels from the left edge",
      showWhen: { operation: ["crop"] },
    }),
  top: z
    .number()
    .int()
    .min(0)
    .default(0)
    .meta({
      title: "Top",
      description: "Pixels from the top edge",
      showWhen: { operation: ["crop"] },
    }),
  degrees: z
    .number()
    .min(-360)
    .max(360)
    .default(90)
    .meta({
      title: "Degrees",
      description: "Clockwise",
      showWhen: { operation: ["rotate"] },
    }),
  sigma: z
    .number()
    .min(0.3)
    .max(1000)
    .default(5)
    .meta({
      title: "Blur Strength",
      showWhen: { operation: ["blur"] },
    }),
  format: z
    .enum(FORMATS)
    .default("keep")
    .meta({
      title: "Format",
      labels: { keep: "Keep", jpeg: "JPEG", png: "PNG", webp: "WebP", avif: "AVIF" },
      hints: {
        keep: "Save in the format of the input",
        jpeg: "Small photos. No transparency.",
        png: "Lossless. Transparency works.",
        webp: "Small files. Transparency works.",
        avif: "Smallest files. Slow to make.",
      },
      showWhen: { operation: ["resize", "crop", "rotate", "blur", "grayscale", "convert"] },
    }),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(80)
    .meta({
      title: "Quality",
      description: "For JPEG, WebP, and AVIF",
      showWhen: { operation: ["resize", "crop", "rotate", "blur", "grayscale", "convert"] },
    }),
});

const EXTENSION: Record<string, string> = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif" };

export default defineNode({
  type: "file.edit_image",
  label: "Edit Image",
  description: "Resize, crop, rotate, blur, or convert an image",
  category: "data",
  actions: [
    { label: "Get information about an image", config: { operation: "info" } },
    { label: "Resize an image", config: { operation: "resize" } },
    { label: "Crop an image", config: { operation: "crop" } },
    { label: "Rotate an image", config: { operation: "rotate" } },
    { label: "Blur an image", config: { operation: "blur" } },
    { label: "Make an image grayscale", config: { operation: "grayscale" } },
    { label: "Convert the format of an image", config: { operation: "convert" } },
  ],
  icon: "Image",
  config,
  defaultConfig: {
    operation: "resize",
    property: "data",
    outputProperty: "data",
    fit: "inside",
    left: 0,
    top: 0,
    degrees: 90,
    sigma: 5,
    format: "keep",
    quality: 80,
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (cfg) => (typeof cfg.operation === "string" ? cfg.operation : undefined),
  async run({ config: cfg, input }) {
    // sharp has native code. It loads on first use, and the browser bundle does not have it.
    const { default: sharp } = await import("sharp");
    const file = readBinary(input, cfg.property);
    const source = Buffer.from(file.data, "base64");
    let image = sharp(source, { failOn: "error" });
    let meta: Awaited<ReturnType<typeof image.metadata>>;
    try {
      meta = await image.metadata();
    } catch {
      throw new Error("The binary data is not an image that this node can read");
    }
    if (cfg.operation === "info") {
      return {
        port: "out",
        data: {
          width: meta.width ?? null,
          height: meta.height ?? null,
          format: meta.format ?? null,
          hasAlpha: meta.hasAlpha ?? false,
          size: source.length,
        },
      };
    }
    switch (cfg.operation) {
      case "resize":
        if (!cfg.width && !cfg.height) throw new Error("Add a width or a height");
        image = image.resize({ width: cfg.width, height: cfg.height, fit: cfg.fit });
        break;
      case "crop":
        if (!cfg.width || !cfg.height) throw new Error("Add a width and a height");
        if (cfg.left + cfg.width > (meta.width ?? 0) || cfg.top + cfg.height > (meta.height ?? 0)) {
          throw new Error(
            `The crop area is outside the image (${meta.width}x${meta.height} pixels)`,
          );
        }
        image = image.extract({
          left: cfg.left,
          top: cfg.top,
          width: cfg.width,
          height: cfg.height,
        });
        break;
      case "rotate":
        image = image.rotate(cfg.degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
        break;
      case "blur":
        image = image.blur(cfg.sigma);
        break;
      case "grayscale":
        image = image.grayscale();
        break;
      case "convert":
        if (cfg.format === "keep") throw new Error("Pick a format");
        break;
    }
    const format = cfg.format === "keep" ? meta.format : cfg.format;
    if (format === "jpeg") image = image.jpeg({ quality: cfg.quality });
    else if (format === "webp") image = image.webp({ quality: cfg.quality });
    else if (format === "avif") image = image.avif({ quality: cfg.quality });
    else if (format === "png") image = image.png();
    const bytes = await image.toBuffer();
    const name = format ?? "png";
    const stem = (file.fileName ?? "image").replace(/\.[^.]+$/, "");
    return {
      port: "out",
      data: {
        binary: {
          [cfg.outputProperty]: toBinary(
            bytes,
            `${stem}.${EXTENSION[name] ?? name}`,
            `image/${name}`,
          ),
        },
      },
    };
  },
});
