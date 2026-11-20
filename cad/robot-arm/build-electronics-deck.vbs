Option Explicit

Const swSaveAsOptions_Silent = 1
Const swExportStlUnits = 211
Const swMM = 0
Const swSTLBinaryFormat = 69
Const swSTLShowInfoOnSave = 70
Const swSTLDontTranslateToPositive = 71

Dim args, fso, output, template, suffix, sw, doc, sketch, feature
Dim oldUnits, oldBinary, oldInfo, oldOrigin, saved, exportError
Set args = WScript.Arguments
If args.Count <> 2 Then
  WScript.Echo "Usage: cscript //nologo build-electronics-deck.vbs <part-template.prtdot> <output-folder>"
  WScript.Quit 2
End If
Set fso = CreateObject("Scripting.FileSystemObject")
template = fso.GetAbsolutePathName(args(0))
output = fso.GetAbsolutePathName(args(1))
If Not fso.FileExists(template) Then Fail "Part template does not exist: " & template
If Not fso.FolderExists(output) Then Fail "Create the output folder first: " & output
For Each suffix In Array(".SLDPRT", ".step", ".stl")
  If fso.FileExists(fso.BuildPath(output, "electronics-deck" & suffix)) Then Fail "Output already exists: electronics-deck" & suffix
Next

On Error Resume Next
Set sw = GetObject(, "SldWorks.Application")
If Err.Number <> 0 Then
  Err.Clear
  Set sw = CreateObject("SldWorks.Application")
End If
If Err.Number <> 0 Then Fail "Could not start SOLIDWORKS: " & Err.Description
On Error GoTo 0
WScript.Echo "SOLIDWORKS revision " & sw.RevisionNumber
Set doc = sw.NewDocument(template, 0, 0, 0)
If doc Is Nothing Then Fail "SOLIDWORKS could not open the part template"

' The dimensions below are millimeters. SOLIDWORKS sketch calls use meters.
' Front Plane puts the STL footprint in XY, with thickness along printer Z.
If Not doc.Extension.SelectByID2("Front Plane", "PLANE", 0, 0, 0, False, 0, Nothing, 0) Then
  Fail "Use a standard English-language part template with a Front Plane"
End If
Set sketch = doc.SketchManager
sketch.InsertSketch True
sketch.AddToDB = True
sketch.CreateCornerRectangle -0.0425, -0.03, 0, 0.0425, 0.03, 0
Rect -32, 19
Rect 32, 19
Rect -32, -19
Rect 32, -19
sketch.CreateCircleByRadius -0.0365, -0.0245, 0, 0.00175
sketch.CreateCircleByRadius 0.0365, -0.0245, 0, 0.00175
sketch.CreateCircleByRadius -0.0365, 0.0245, 0, 0.00175
sketch.CreateCircleByRadius 0.0365, 0.0245, 0, 0.00175
sketch.AddToDB = False
sketch.InsertSketch True
Set feature = doc.FeatureManager.FeatureExtrusion2(True, False, False, 0, 0, 0.0032, 0, _
  False, False, False, False, 0, 0, False, False, False, False, True, True, True, 0, 0, False)
If feature Is Nothing Then Fail "SOLIDWORKS could not extrude the deck sketch"
feature.Name = "Electronics deck"
doc.ClearSelection2 True
doc.ViewZoomtofit2
If Not SaveModel(".SLDPRT") Then Fail "Native part export failed"
If Not SaveModel(".step") Then Fail "STEP export failed"

oldUnits = sw.GetUserPreferenceIntegerValue(swExportStlUnits)
oldBinary = sw.GetUserPreferenceToggle(swSTLBinaryFormat)
oldInfo = sw.GetUserPreferenceToggle(swSTLShowInfoOnSave)
oldOrigin = sw.GetUserPreferenceToggle(swSTLDontTranslateToPositive)
On Error Resume Next
sw.SetUserPreferenceIntegerValue swExportStlUnits, swMM
sw.SetUserPreferenceToggle swSTLBinaryFormat, True
sw.SetUserPreferenceToggle swSTLShowInfoOnSave, False
sw.SetUserPreferenceToggle swSTLDontTranslateToPositive, True
If Err.Number = 0 Then saved = SaveModel(".stl")
exportError = Err.Description
sw.SetUserPreferenceIntegerValue swExportStlUnits, oldUnits
sw.SetUserPreferenceToggle swSTLBinaryFormat, oldBinary
sw.SetUserPreferenceToggle swSTLShowInfoOnSave, oldInfo
sw.SetUserPreferenceToggle swSTLDontTranslateToPositive, oldOrigin
On Error GoTo 0
If Not saved Then Fail "STL export failed: " & exportError
sw.CloseDoc doc.GetTitle

Sub Rect(x, y)
  sketch.CreateCornerRectangle (x - 6) / 1000, (y - 1.75) / 1000, 0, _
    (x + 6) / 1000, (y + 1.75) / 1000, 0
End Sub

Function SaveModel(extension)
  Dim destination, errors
  destination = fso.BuildPath(output, "electronics-deck" & extension)
  errors = doc.SaveAs3(destination, 0, swSaveAsOptions_Silent)
  SaveModel = errors = 0 And fso.FileExists(destination)
  WScript.Echo destination & " (errors=" & errors & ")"
End Function

Sub Fail(message)
  WScript.StdErr.WriteLine message
  WScript.Quit 1
End Sub
