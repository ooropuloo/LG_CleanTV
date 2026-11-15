"""agy vision: image check + rig landmarks in one call.

Coordinates are asked as integers on a 0..1000 grid for BOTH axes (x = 1000 * px / width, y = 1000 * py / height);
the image we send has a faint labelled grid every 100 units to help the model. Converted to source px here.
"""
PT = {'type': 'object', 'properties': {'x': {'type': 'integer'}, 'y': {'type': 'integer'}}, 'required': ['x', 'y']}
BOX = {'type': 'object', 'properties': {k: {'type': 'integer'} for k in ('x0', 'y0', 'x1', 'y1')}, 'required': ['x0', 'y0', 'x1', 'y1']}
PTS = {'type': 'array', 'items': PT}
EAR = {'type': 'object', 'properties': {'tip': PT, 'base': PT}, 'required': ['tip', 'base']}

CAT = {
    'type': 'object',
    'properties': {
        'eyes_open': {'type': 'boolean', 'description': 'both eyes clearly open'},
        'left_eye': dict(BOX, description='tight box around the visible eyeball (iris + rim) of the eye on the LEFT side of the picture'),
        'right_eye': dict(BOX, description='tight box around the visible eyeball of the eye on the RIGHT side of the picture'),
        'nose': PT,
        'chin': dict(PT, description='lowest point of the chin / mouth'),
        'head_outline': dict(PTS, description='14-20 points clockwise around the whole head INCLUDING both ears and the cheek fur, excluding the body and paws'),
        'left_ear': dict(EAR, description='ear on the left side of the picture: tip point and the centre of its base where it joins the head'),
        'right_ear': EAR,
        'tail_visible': {'type': 'boolean'},
        'tail_centerline': dict(PTS, description='6-9 points along the middle of the tail from where it leaves the body/ledge (base) to the tip, following its curve'),
        'tail_width': {'type': 'integer', 'description': 'typical tail thickness, in the same 0..1000 units as x'},
        'body_outline': dict(PTS, description='8-14 points around the visible body/chest/shoulders below the head down to the ledge (exclude head, tail, paws)'),
        'paws': {'type': 'array', 'items': BOX, 'description': 'boxes around visible front paws'},
    },
    'required': ['eyes_open', 'left_eye', 'right_eye', 'nose', 'chin', 'head_outline', 'left_ear', 'right_ear',
                 'tail_visible', 'tail_centerline', 'tail_width', 'body_outline', 'paws'],
}
PERSON = {
    'type': 'object',
    'properties': {
        'left_eye': dict(BOX, description='tight box around the visible eye (between the lids) on the LEFT side of the picture'),
        'right_eye': BOX,
        'face_outline': dict(PTS, description='12-18 points clockwise around the face from the hairline over the forehead, cheeks and jaw to the chin (skin only, exclude hair falling beside the face)'),
        'chin': PT,
        'head_top': PT,
        'shoulder_y': {'type': 'integer', 'description': 'y of the top of the shoulders'},
        'arms_y': {'type': 'integer', 'description': 'y where the arms/hands rest on the table or ledge'},
        'body_outline': dict(PTS, description='8-14 points around the upper body (shoulders, chest, arms) excluding the head'),
        'hair_left': dict(PTS, description='polygon around the long hair hanging on the LEFT side of the face below the ears (empty if none)'),
        'hair_right': dict(PTS, description='same on the RIGHT side (empty if none)'),
    },
    'required': ['left_eye', 'right_eye', 'face_outline', 'chin', 'head_top', 'shoulder_y', 'arms_y', 'body_outline', 'hair_left', 'hair_right'],
}

SCHEMA = {
    'type': 'object',
    'properties': {
        'usable': {'type': 'boolean', 'description': 'false if ANY hard problem listed in the instructions is present'},
        'problems': {'type': 'array', 'items': {'type': 'string'}},
        'ledge': dict(PTS, description='7 points along the top edge of the ledge/blanket/table that hides the lower part of the subjects, at x = 0, 166, 333, 500, 666, 833, 1000; where a subject sits on it, the line where the subject meets the ledge'),
        'cats': {'type': 'array', 'items': CAT},
        'people': {'type': 'array', 'items': PERSON},
    },
    'required': ['usable', 'problems', 'ledge', 'cats', 'people'],
}

PROMPT = """You are the quality checker and rigging assistant for an animated TV wallpaper pipeline.
Image 1 is the candidate picture, image 2 is the same picture with a faint labelled grid (0..1000 on both axes; x to the right, y down).
Expected content: {expect}

Step 1 - decide `usable`. It is NOT usable if any of these is true: wrong number of cats or people; extra/missing/merged legs, paws, ears, eyes or tails;
a cat's eyes closed/half closed when they should be open; the head is cut by the picture border; the subject is not behind a ledge/blanket/table
that hides its lower body; visible text, logos or watermark; a collage/split image; a strongly distorted or melted face; the cat is not a {coat};
{extra}List every problem found in `problems` (short phrases).

Step 2 - landmarks, as integers on the 0..1000 grid (use image 2's grid labels to be precise; x and y are both 0..1000 regardless of the aspect ratio).
"Left"/"right" always mean the left/right side of the PICTURE. Boxes are tight. Points must be ON the described feature.
For a sleeping cat with closed eyes set eyes_open=false and give the boxes of the closed eyes anyway.
If there is no person, `people` is []. If the tail is not visible set tail_visible=false and give an empty tail_centerline."""
