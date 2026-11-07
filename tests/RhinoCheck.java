// Syntax check with the pack's Rhino fork (KubeJS 1802 parser), which rejects some valid JS (e.g. `delete obj[k]`).
// java -cp "<instance>/minecraft/mods/rhino-forge-1802.2.1-build.255.jar" tests/RhinoCheck.java tools/kubejs/wdo_deck_export.js
import dev.latvian.mods.rhino.*;
import java.nio.file.*;
public class RhinoCheck {
  public static void main(String[] a) throws Exception {
    String src = Files.readString(Path.of(a[0]));
    CompilerEnvirons env = new CompilerEnvirons();
    try { new Parser(env).parse(src, a[0], 1); System.out.println("PARSE OK"); }
    catch (EvaluatorException e) { System.out.println("PARSE ERROR line " + e.lineNumber() + ": " + e.details() + " | " + e.lineSource()); }
  }
}
