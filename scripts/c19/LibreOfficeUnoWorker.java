import com.sun.star.beans.PropertyValue;
import com.sun.star.bridge.XUnoUrlResolver;
import com.sun.star.comp.helper.Bootstrap;
import com.sun.star.container.XNamed;
import com.sun.star.drawing.XDrawPages;
import com.sun.star.drawing.XDrawPagesSupplier;
import com.sun.star.drawing.XShapes;
import com.sun.star.frame.XComponentLoader;
import com.sun.star.frame.XDesktop;
import com.sun.star.frame.XStorable;
import com.sun.star.lang.XComponent;
import com.sun.star.text.XText;
import com.sun.star.uno.UnoRuntime;
import com.sun.star.uno.XComponentContext;
import com.sun.star.util.XCloseable;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;

/** Real UNO edit/save/reopen/export worker for the C19 LibreOffice suite. */
public final class LibreOfficeUnoWorker {
  private LibreOfficeUnoWorker() {}

  private static PropertyValue property(String name, Object value) {
    PropertyValue result = new PropertyValue();
    result.Name = name;
    result.Value = value;
    return result;
  }

  private static String sha256(String value) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
  }

  private static String json(String value) {
    return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\r", "\\r").replace("\n", "\\n") + "\"";
  }

  private static Object findNamedShape(XShapes shapes, String target) throws Exception {
    for (int index = 0; index < shapes.getCount(); index += 1) {
      Object shape = shapes.getByIndex(index);
      XNamed named = UnoRuntime.queryInterface(XNamed.class, shape);
      if (named != null && target.equals(named.getName())) return shape;
      XShapes children = UnoRuntime.queryInterface(XShapes.class, shape);
      if (children != null) {
        Object nested = findNamedShape(children, target);
        if (nested != null) return nested;
      }
    }
    return null;
  }

  private static Object findNamedShape(XComponent document, String target) throws Exception {
    XDrawPagesSupplier supplier = UnoRuntime.queryInterface(XDrawPagesSupplier.class, document);
    if (supplier == null) throw new IllegalStateException("UNO document is not an Impress presentation.");
    XDrawPages pages = supplier.getDrawPages();
    for (int slide = 0; slide < pages.getCount(); slide += 1) {
      XShapes shapes = UnoRuntime.queryInterface(XShapes.class, pages.getByIndex(slide));
      Object result = findNamedShape(shapes, target);
      if (result != null) return result;
    }
    return null;
  }

  private static int slideCount(XComponent document) {
    XDrawPagesSupplier supplier = UnoRuntime.queryInterface(XDrawPagesSupplier.class, document);
    return supplier.getDrawPages().getCount();
  }

  private static XComponent load(XComponentLoader loader, Path file) throws Exception {
    Object loaded = loader.loadComponentFromURL(
      file.toUri().toASCIIString(),
      "_blank",
      0,
      new PropertyValue[] { property("Hidden", Boolean.TRUE), property("ReadOnly", Boolean.FALSE) }
    );
    XComponent component = UnoRuntime.queryInterface(XComponent.class, loaded);
    if (component == null) throw new IllegalStateException("UNO did not return an editable presentation component.");
    return component;
  }

  private static void close(XComponent document) throws Exception {
    if (document == null) return;
    XCloseable closeable = UnoRuntime.queryInterface(XCloseable.class, document);
    if (closeable != null) closeable.close(true);
    else document.dispose();
  }

  private static XComponentContext connect(int port) throws Exception {
    XComponentContext local = Bootstrap.createInitialComponentContext(null);
    Object resolverObject = local.getServiceManager().createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local);
    XUnoUrlResolver resolver = UnoRuntime.queryInterface(XUnoUrlResolver.class, resolverObject);
    Exception last = null;
    for (int attempt = 0; attempt < 120; attempt += 1) {
      try {
        Object remote = resolver.resolve("uno:socket,host=127.0.0.1,port=" + port + ";urp;StarOffice.ComponentContext");
        return UnoRuntime.queryInterface(XComponentContext.class, remote);
      } catch (Exception error) {
        last = error;
        Thread.sleep(500L);
      }
    }
    throw new IllegalStateException("Could not connect to the owned LibreOffice UNO endpoint.", last);
  }

  public static void main(String[] args) throws Exception {
    if (args.length != 7) {
      throw new IllegalArgumentException("Usage: <port> <input.pptx> <output.pptx> <output.pdf> <target-name> <replacement> <report.json>");
    }
    int port = Integer.parseInt(args[0]);
    Path input = Path.of(args[1]).toAbsolutePath();
    Path output = Path.of(args[2]).toAbsolutePath();
    Path pdf = Path.of(args[3]).toAbsolutePath();
    String target = args[4];
    String replacement = args[5];
    Path report = Path.of(args[6]).toAbsolutePath();
    Instant startedAt = Instant.now();
    XDesktop desktop = null;
    XComponent source = null;
    XComponent reopened = null;
    try {
      XComponentContext context = connect(port);
      Object desktopObject = context.getServiceManager().createInstanceWithContext("com.sun.star.frame.Desktop", context);
      desktop = UnoRuntime.queryInterface(XDesktop.class, desktopObject);
      XComponentLoader loader = UnoRuntime.queryInterface(XComponentLoader.class, desktopObject);
      source = load(loader, input);
      int slides = slideCount(source);
      Object targetShape = findNamedShape(source, target);
      XText targetText = UnoRuntime.queryInterface(XText.class, targetShape);
      if (targetText == null) throw new IllegalStateException("Named UNO text target was not found: " + target);
      String before = targetText.getString();
      targetText.setString(replacement);
      XStorable sourceStore = UnoRuntime.queryInterface(XStorable.class, source);
      sourceStore.storeAsURL(output.toUri().toASCIIString(), new PropertyValue[] {
        property("FilterName", "Impress MS PowerPoint 2007 XML"),
        property("Overwrite", Boolean.TRUE)
      });
      close(source);
      source = null;

      reopened = load(loader, output);
      Object reopenedShape = findNamedShape(reopened, target);
      XText reopenedText = UnoRuntime.queryInterface(XText.class, reopenedShape);
      boolean matched = reopenedText != null && replacement.equals(reopenedText.getString());
      if (!matched) throw new IllegalStateException("LibreOffice native sentinel text did not survive save and reopen.");
      XStorable reopenedStore = UnoRuntime.queryInterface(XStorable.class, reopened);
      reopenedStore.storeToURL(pdf.toUri().toASCIIString(), new PropertyValue[] {
        property("FilterName", "impress_pdf_Export"),
        property("Overwrite", Boolean.TRUE)
      });
      Instant endedAt = Instant.now();
      String payload = "{\n"
        + "  \"schemaVersion\": \"slidewright-c19-libreoffice-worker/v1\",\n"
        + "  \"valid\": true,\n"
        + "  \"protocol\": \"uno\",\n"
        + "  \"targetObjectId\": " + json(target) + ",\n"
        + "  \"beforeTextSha256\": " + json(sha256(before)) + ",\n"
        + "  \"afterTextSha256\": " + json(sha256(replacement)) + ",\n"
        + "  \"reopenedNativeTextMatched\": true,\n"
        + "  \"slideCount\": " + slides + ",\n"
        + "  \"startedAt\": " + json(startedAt.toString()) + ",\n"
        + "  \"endedAt\": " + json(endedAt.toString()) + "\n"
        + "}\n";
      Files.createDirectories(report.getParent());
      Files.writeString(report, payload, StandardCharsets.UTF_8);
    } finally {
      try { close(reopened); } catch (Exception ignored) {}
      try { close(source); } catch (Exception ignored) {}
      if (desktop != null) {
        try { desktop.terminate(); } catch (Exception ignored) {}
      }
    }
  }
}
