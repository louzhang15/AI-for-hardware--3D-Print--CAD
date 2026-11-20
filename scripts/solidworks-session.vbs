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

WScript.StdOut.WriteLine "{""status"":""active"",""revision"":" & Quote(revision) & ",""document"":{""title"":" & Quote(title) & _
  ",""type"":" & Quote(kind) & ",""unsavedChanges"":" & dirty & ",""configuration"":" & Quote(config) & _
  ",""activeSketch"":" & Quote(sketch) & "},""selectionCount"":" & count & ",""selection"":[" & items & "]}"

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
