Option Explicit

Dim sw, doc, revision, title, kind, dirty, config, sketch, selection
Dim count, i, items, selectionType

On Error Resume Next
Set sw = GetObject(, "SldWorks.Application")
If Err.Number <> 0 Then
  WScript.StdOut.WriteLine "{""status"":""unavailable"",""message"":""Open SOLIDWORKS in this Windows session and try again.""}"
  WScript.Quit 1
End If
On Error GoTo 0

revision = sw.RevisionNumber
Set doc = sw.ActiveDoc
If doc Is Nothing Then
  WScript.StdOut.WriteLine "{""status"":""no_document"",""revision"":" & Quote(revision) & "}"
  WScript.Quit 1
End If

title = doc.GetTitle
Select Case doc.GetType
  Case 1: kind = "part"
  Case 2: kind = "assembly"
  Case 3: kind = "drawing"
  Case Else: kind = "unknown"
End Select
dirty = LCase(CStr(doc.GetSaveFlag))
config = ConfigurationName(doc)
sketch = SketchStatus(doc)

Set selection = doc.SelectionManager
count = selection.GetSelectedObjectCount2(-1)
items = ""
For i = 1 To count
  If i > 20 Then Exit For
  If i > 1 Then items = items & ","
  selectionType = selection.GetSelectedObjectType3(i, -1)
  items = items & "{""typeCode"":" & selectionType & ",""name"":" & Quote(SelectionName(selection, i)) & "}"
Next

Dim docPath, material, size, mass, tree
docPath = PathOf(doc)
material = MaterialOf(doc, kind)
size = BoxOf(kind)
mass = MassOf(doc)
tree = FeatureTree(doc)

WScript.StdOut.WriteLine "{""status"":""active"",""revision"":" & Quote(revision) & ",""document"":{""title"":" & Quote(title) & _
  ",""type"":" & Quote(kind) & ",""path"":" & Quote(docPath) & ",""unsavedChanges"":" & dirty & ",""configuration"":" & Quote(config) & _
  ",""activeSketch"":" & Quote(sketch) & ",""material"":" & Quote(material) & ",""sizeMm"":" & size & ",""mass"":" & mass & _
  "},""features"":" & tree & ",""selectionCount"":" & count & ",""selection"":[" & items & "]}"

' Decimal point regardless of the Windows locale.
Function Num(value)
  Num = Replace(CStr(Round(CDbl(value), 3)), ",", ".")
End Function

Function PathOf(model)
  On Error Resume Next
  PathOf = model.GetPathName
End Function

Function MaterialOf(model, docKind)
  On Error Resume Next
  Dim db
  MaterialOf = Empty
  If docKind = "part" Then MaterialOf = model.GetMaterialPropertyName2("", db)
  If MaterialOf = "" Then MaterialOf = Empty
End Function

' Bounding box in mm: [x, y, z] sizes, or null.
' GetPartBox and GetBox return a typed Double() array that VBScript cannot index
' ("Type mismatch"), so PowerShell reads the box from the active document.
Function BoxOf(docKind)
  On Error Resume Next
  Dim boxCall, exec, text
  BoxOf = "null"
  If docKind = "part" Then
    boxCall = "'GetPartBox',$m,$null,$d,@($true)"
  ElseIf docKind = "assembly" Then
    boxCall = "'GetBox',$m,$null,$d,@(0)"
  Else
    Exit Function
  End If
  Set exec = CreateObject("WScript.Shell").Exec("powershell.exe -NoProfile -NonInteractive -Command " & _
    """$ErrorActionPreference='Stop'; $t=[System.__ComObject]; $m=[Reflection.BindingFlags]::InvokeMethod; " & _
    "$sw=[Runtime.InteropServices.Marshal]::GetActiveObject('SldWorks.Application'); " & _
    "$d=$t.InvokeMember('ActiveDoc',[Reflection.BindingFlags]::GetProperty,$null,$sw,$null); " & _
    "$b=$t.InvokeMember(" & boxCall & "); " & _
    "'['+((0..2|%{[math]::Round([math]::Abs($b[$_+3]-$b[$_])*1000,3).ToString([cultureinfo]::InvariantCulture)}) -join ',')+']'""")
  If Err.Number <> 0 Then Exit Function
  text = Trim(Replace(Replace(exec.StdOut.ReadAll, vbCr, ""), vbLf, ""))
  If Left(text, 1) = "[" And Right(text, 1) = "]" And UBound(Split(text, ",")) = 2 Then BoxOf = text
End Function

' Mass in grams and volume in cm3, or null.
Function MassOf(model)
  On Error Resume Next
  Dim mp
  MassOf = "null"
  Set mp = model.Extension.CreateMassProperty
  If Err.Number <> 0 Or mp Is Nothing Then Exit Function
  MassOf = "{""grams"":" & Num(mp.Mass * 1000) & ",""volumeCm3"":" & Num(mp.Volume * 1000000) & "}"
  If Err.Number <> 0 Then MassOf = "null"
End Function

' Feature tree: the last 40 features plus every feature or mate with an error or warning.
Function FeatureTree(model)
  On Error Resume Next
  Dim feat, subFeat, list, problems, total, entry, recent(39), nRecent, k, start
  total = 0
  nRecent = 0
  problems = ""
  Set feat = model.FirstFeature
  Do While Not feat Is Nothing
    total = total + 1
    entry = FeatureJson(feat)
    recent(nRecent Mod 40) = entry
    nRecent = nRecent + 1
    If HasProblem(feat) Then problems = AddItem(problems, entry)
    If feat.GetTypeName2 = "MateGroup" Then
      Set subFeat = feat.GetFirstSubFeature
      Do While Not subFeat Is Nothing
        If HasProblem(subFeat) Then problems = AddItem(problems, FeatureJson(subFeat))
        Set subFeat = subFeat.GetNextSubFeature
      Loop
    End If
    If total > 2000 Then Exit Do
    Set feat = feat.GetNextFeature
  Loop
  list = ""
  start = 0
  If nRecent > 40 Then start = nRecent - 40
  For k = start To nRecent - 1
    list = AddItem(list, recent(k Mod 40))
  Next
  FeatureTree = "{""total"":" & total & ",""recent"":[" & list & "],""problems"":[" & problems & "]}"
End Function

Function AddItem(listText, item)
  If listText = "" Then AddItem = item Else AddItem = listText & "," & item
End Function

Function HasProblem(feat)
  On Error Resume Next
  Dim isWarning, code
  isWarning = False
  code = feat.GetErrorCode2(isWarning)
  HasProblem = (Err.Number = 0 And code <> 0)
End Function

Function FeatureJson(feat)
  On Error Resume Next
  Dim isWarning, code, suppressed
  isWarning = False
  code = feat.GetErrorCode2(isWarning)
  If Err.Number <> 0 Then code = 0: Err.Clear
  suppressed = LCase(CStr(feat.IsSuppressed))
  If suppressed <> "true" Then suppressed = "false"
  FeatureJson = "{""name"":" & Quote(feat.Name) & ",""type"":" & Quote(feat.GetTypeName2) & _
    ",""suppressed"":" & suppressed & ",""errorCode"":" & CLng(code) & ",""warning"":" & LCase(CStr(CBool(isWarning))) & "}"
End Function

Function ConfigurationName(model)
  On Error Resume Next
  ConfigurationName = model.ConfigurationManager.ActiveConfiguration.Name
End Function

Function SketchStatus(model)
  On Error Resume Next
  Dim activeSketch
  Set activeSketch = model.SketchManager.ActiveSketch
  If Not activeSketch Is Nothing Then
    SketchStatus = "unknown"
    Select Case activeSketch.GetConstrainedStatus
      Case 2: SketchStatus = "under defined"
      Case 3: SketchStatus = "fully defined"
      Case 4: SketchStatus = "over defined"
      Case 5: SketchStatus = "no solution"
      Case 6: SketchStatus = "invalid solution"
      Case 7: SketchStatus = "automatic solving off"
    End Select
  End If
End Function

Function SelectionName(manager, index)
  On Error Resume Next
  Dim item
  Set item = manager.GetSelectedObject6(index, -1)
  If Not item Is Nothing Then
    SelectionName = item.Name
    If Err.Number <> 0 Then
      Err.Clear
      SelectionName = item.Name2
    End If
  End If
End Function

Function Quote(value)
  If IsEmpty(value) Or IsNull(value) Then
    Quote = "null"
    Exit Function
  End If
  Dim result, index, character, code
  result = """"
  For index = 1 To Len(value)
    character = Mid(value, index, 1)
    code = AscW(character)
    If code >= 0 And code < 32 Then
      result = result & "\u" & Right("0000" & Hex(code), 4)
    ElseIf code = 34 Or code = 92 Then
      result = result & "\" & character
    Else
      result = result & character
    End If
  Next
  Quote = result & """"
End Function
